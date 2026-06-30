"use strict";
/* ============================================================
   VOXFORGE — backend API
   - POST /api/assist      : proxies Claude, returns a suggested
                             processing chain (JSON settings + rationale)
   - POST /api/transcribe  : runs Whisper (OpenAI or Groq) on an
                             uploaded audio/video file
   - GET  /health          : liveness
   - GET  /api/hub/health   /api/hub/stats : optional Finance-Minister
                             hub connector (enabled by HUB_API_KEY)
   The Anthropic + Whisper keys live ONLY here, never in the browser.
   ============================================================ */

import express from "express";
import cors from "cors";
import multer from "multer";

const VERSION = "1.0.0";
const PORT = process.env.PORT || 8080;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const WHISPER_PROVIDER = (process.env.WHISPER_PROVIDER || "openai").toLowerCase();
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const HUB_API_KEY = process.env.HUB_API_KEY || "";

const PROVIDERS = {
  openai: {
    base: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    key: () => process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "whisper-1",
    keyName: "OPENAI_API_KEY",
  },
  groq: {
    base: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    key: () => process.env.GROQ_API_KEY || "",
    model: process.env.GROQ_MODEL || "whisper-large-v3",
    keyName: "GROQ_API_KEY",
  },
};

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: "1mb" }));

const corsOrigin =
  ALLOWED_ORIGIN === "*" ? "*" : ALLOWED_ORIGIN.split(",").map((s) => s.trim());
app.use(cors({ origin: corsOrigin }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const startedAt = Date.now();
const stats = { assistCalls: 0, transcribeCalls: 0, errors: 0 };

/* ---------- the contract Claude must follow ---------- */
const PARAM_DOC = `You tune a vocal processing chain whose job is to make AI / TTS voices (ElevenLabs, etc.) sound like a real human recorded in a real room. Return ONLY a JSON object (no prose, no markdown fences) using any subset of these keys. Stay strictly within the ranges.

inGain dB[-24..24]; hpf Hz[20..400] (20=off); lpf Hz[2000..20000] (20000=off);
eq: array of 14 dB values[-15..15] for freqs 40,63,100,160,250,400,630,1000,1600,2500,4000,6300,10000,16000;
deEss[0..100], deEssFreq Hz[3000..10000];
compOn boolean, compThresh dB[-60..0], compRatio[1..20], compAttack s[0.001..0.2], compRelease s[0.02..1], compKnee[0..40], compMakeup dB[0..24];
warmth[0..100] (tube/tape drive), warmthMix[0..100], air[0..100] (high-freq exciter / breath);
wobbleDepth[0..100] (micro pitch variation that breaks robotic perfection), wobbleRate[0.1..8], wobbleMix[0..100], roomTone[0..100] (subtle noise floor for realism);
revSize[0..100], revDecay[0..100], revPredelay ms[0..150], revDamp[0..100], revMix[0..100];
delTime ms[0..1000], delFb[0..95], delTone[0..100], delMix[0..100];
width[0..200], limitOn boolean, ceiling dB[-3..0], outGain dB[-24..24].

Also add a top-level string field "_why": one or two plain sentences explaining the choices.

Guidance: the strongest levers for de-robotising a voice are — de-essing harsh sibilance, a gentle low-mid warmth bump, a small 3-4k harshness dip, a touch of presence/air, light tape/tube saturation, a SMALL natural room reverb, a little room tone, and modest pitch wobble. If measured audio features are supplied, use them: high sibilance% -> more de-ess; boomy low% -> raise hpf / trim lows; dull (low air%, low spectral centroid) -> add air; very high crest -> gentle compression. Avoid extreme settings that introduce artifacts; subtlety reads as "real".`;

/* ---------- clamp / validate the model's JSON ---------- */
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
function sanitize(obj) {
  const o = {};
  const map = {
    inGain: [-24, 24], hpf: [20, 400], lpf: [2000, 20000],
    deEss: [0, 100], deEssFreq: [3000, 10000],
    compThresh: [-60, 0], compRatio: [1, 20], compAttack: [0.001, 0.2],
    compRelease: [0.02, 1], compKnee: [0, 40], compMakeup: [0, 24],
    warmth: [0, 100], warmthMix: [0, 100], air: [0, 100],
    wobbleDepth: [0, 100], wobbleRate: [0.1, 8], wobbleMix: [0, 100], roomTone: [0, 100],
    revSize: [0, 100], revDecay: [0, 100], revPredelay: [0, 150], revDamp: [0, 100], revMix: [0, 100],
    delTime: [0, 1000], delFb: [0, 95], delTone: [0, 100], delMix: [0, 100],
    width: [0, 200], ceiling: [-3, 0], outGain: [-24, 24],
  };
  for (const k in obj) {
    if (k === "eq" && Array.isArray(obj.eq)) {
      o.eq = obj.eq.slice(0, 14).map((v) => {
        const n = Number(v);
        return Number.isFinite(n) ? clamp(n, -15, 15) : 0;
      });
      while (o.eq.length < 14) o.eq.push(0);
    } else if (k === "compOn" || k === "limitOn") {
      o[k] = !!obj[k];
    } else if (map[k]) {
      const raw = obj[k];
      const bad = raw === null || raw === "" || typeof raw === "boolean" || typeof raw === "object";
      const v = bad ? NaN : Number(raw);
      if (Number.isFinite(v)) o[k] = clamp(v, map[k][0], map[k][1]);
    }
  }
  return o;
}

/* ---------- routes ---------- */
app.get("/", (_req, res) =>
  res.json({
    name: "voxforge-backend",
    version: VERSION,
    ok: true,
    whisperProvider: WHISPER_PROVIDER,
    endpoints: ["/health", "/api/assist", "/api/transcribe", "/api/hub/health", "/api/hub/stats"],
  })
);

app.get("/health", (_req, res) =>
  res.json({ ok: true, version: VERSION, uptimeSec: (Date.now() - startedAt) / 1000 })
);

/* ----- Claude: suggest a processing chain ----- */
app.post("/api/assist", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY)
      return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });

    const { description = "", model, features = null, transcript = "" } = req.body || {};
    if (!String(description).trim() && !features)
      return res.status(400).json({ error: "Provide a description of the voice (or measured features)." });

    let userText = "Voice description: " + (description || "(none given)") + "\n";
    if (features) userText += "\nMeasured audio features (JSON): " + JSON.stringify(features) + "\n";
    if (transcript)
      userText +=
        '\nTranscript excerpt for prosody/context (do NOT change the words, this is only context): "' +
        String(transcript).slice(0, 1500) +
        '"\n';
    userText += "\nReturn the JSON settings now.";

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: model || ANTHROPIC_MODEL,
        max_tokens: 1200,
        system: PARAM_DOC,
        messages: [{ role: "user", content: userText }],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      stats.errors++;
      return res.status(r.status).json({ error: "anthropic_error", detail: data });
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ error: "no_json_in_model_output", raw: text.slice(0, 500) });

    let obj;
    try {
      obj = JSON.parse(m[0]);
    } catch (e) {
      return res.status(502).json({ error: "bad_json_from_model", raw: m[0].slice(0, 500) });
    }
    const why = obj._why || "";
    delete obj._why;
    stats.assistCalls++;
    res.json({ settings: sanitize(obj), why, model: model || ANTHROPIC_MODEL });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: "server_error", detail: String((err && err.message) || err) });
  }
});

/* ----- Whisper: transcribe an uploaded file ----- */
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    const prov = PROVIDERS[WHISPER_PROVIDER] || PROVIDERS.openai;
    const key = prov.key();
    if (!key)
      return res
        .status(500)
        .json({ error: `No API key for whisper provider "${WHISPER_PROVIDER}". Set ${prov.keyName} on the server.` });
    if (!req.file)
      return res.status(400).json({ error: 'No file uploaded (multipart field name must be "file").' });

    const modelName = req.body.model || prov.model;
    const supportsVerbose = !/gpt-4o/i.test(modelName); // gpt-4o-(mini-)transcribe only support json/text
    const form = new FormData();
    form.append(
      "file",
      new Blob([req.file.buffer], { type: req.file.mimetype || "application/octet-stream" }),
      req.file.originalname || "audio.wav"
    );
    form.append("model", modelName);
    form.append("response_format", supportsVerbose ? "verbose_json" : "json");
    if (req.body.language) form.append("language", req.body.language);

    const r = await fetch(prov.base + "/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const data = await r.json();
    if (!r.ok) {
      stats.errors++;
      return res.status(r.status).json({ error: "whisper_error", detail: data });
    }
    stats.transcribeCalls++;
    const segments = Array.isArray(data.segments)
      ? data.segments.map((s) => ({ start: s.start, end: s.end, text: (s.text || "").trim() }))
      : [];
    res.json({ text: data.text || "", segments, provider: WHISPER_PROVIDER });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: "server_error", detail: String((err && err.message) || err) });
  }
});

/* ----- optional Finance-Minister hub connector ----- */
function hubAuth(req, res) {
  if (!HUB_API_KEY) {
    res.status(404).json({ error: "hub_disabled" });
    return false;
  }
  const k = req.get("x-hub-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (k !== HUB_API_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}
app.get("/api/hub/health", (req, res) => {
  if (!hubAuth(req, res)) return;
  res.json({ status: "ok", service: "voxforge", version: VERSION, uptimeSec: (Date.now() - startedAt) / 1000 });
});
app.get("/api/hub/stats", (req, res) => {
  if (!hubAuth(req, res)) return;
  res.json({
    service: "voxforge",
    version: VERSION,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    assistCalls: stats.assistCalls,
    transcribeCalls: stats.transcribeCalls,
    errors: stats.errors,
    whisperProvider: WHISPER_PROVIDER,
  });
});

/* error handler (covers multer/upload + anything thrown above) -> clean JSON */
app.use((err, _req, res, _next) => {
  const tooBig = /file too large/i.test(String((err && err.message) || ""));
  res
    .status(tooBig ? 413 : 400)
    .json({
      error: tooBig ? "file_too_large" : "request_error",
      limitMb: MAX_UPLOAD_MB,
      detail: String((err && err.message) || err),
    });
});

app.listen(PORT, () =>
  console.log(`voxforge-backend v${VERSION} listening on :${PORT} (whisper=${WHISPER_PROVIDER})`)
);
