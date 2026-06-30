"use strict";
/* ============================================================
   VOXFORGE — backend API (v2)
   - POST /api/assist      : Claude -> suggested processing chain
                             (JSON settings + rationale + tips)
   - POST /api/transcribe  : Whisper (OpenAI / Groq) on a small
                             16k-mono clip the frontend sends
   - POST /api/mux         : ffmpeg -> replaces a video's audio with
                             the processed WAV and returns the video
   - GET  /health
   - GET  /api/hub/health  /api/hub/stats  (optional, HUB_API_KEY)
   API keys live ONLY here, never in the browser.
   ============================================================ */

import express from "express";
import cors from "cors";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const VERSION = "2.0.0";
const PORT = process.env.PORT || 8080;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const WHISPER_PROVIDER = (process.env.WHISPER_PROVIDER || "openai").toLowerCase();
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);     // transcription clip
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 200);      // video for muxing
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const HUB_API_KEY = process.env.HUB_API_KEY || "";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

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

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});
const uploadMux = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }), // disk = RAM-friendly for big video
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 2 },
});

const startedAt = Date.now();
const stats = { assistCalls: 0, transcribeCalls: 0, muxCalls: 0, errors: 0 };

/* ---------- the contract + expertise Claude follows ---------- */
const PARAM_DOC = `You are a world-class dialogue/mastering engineer who specialises in making AI / TTS voices (ElevenLabs, Magic Hour, etc.) pass as a real human recorded on a real mic in a real room. The output is used in PAID ADS, so the bar is "undetectable" — a listener must not clock it as AI or they scroll past. Subtlety wins; over-processing creates new artifacts that also read as fake.

Return ONLY a JSON object (no prose, no markdown fences). Use any subset of these keys; stay strictly within ranges:

inGain dB[-24..24]; hpf Hz[20..400] (20=off, rolls off rumble/plosives); lpf Hz[2000..20000] (20000=off);
deHum[0..100] (notch mains hum + harmonics; 0=off), humBase[50 or 60] (region: 50 EU/Asia, 60 US);
tilt[-100..100] (overall tone tilt: negative=darker/warmer, positive=brighter; 0=off);
eq: array of 14 dB[-15..15] for 40,63,100,160,250,400,630,1000,1600,2500,4000,6300,10000,16000;
deEss[0..100], deEssFreq Hz[3000..10000];
compOn boolean, compThresh dB[-60..0], compRatio[1..20], compAttack s[0.001..0.2], compRelease s[0.02..1], compKnee[0..40], compMakeup dB[0..24];
warmth[0..100] (tube/tape saturation = analog imperfection), warmthMix[0..100], air[0..100] (HF exciter = breath/sparkle);
wobbleDepth[0..100] (micro pitch drift that breaks robotic steadiness — the single biggest de-AI lever for monotone voices), wobbleRate[0.1..8], wobbleMix[0..100], roomTone[0..100] (subtle noise floor so it isn't recorded-in-a-vacuum);
revSize[0..100], revDecay[0..100], revPredelay ms[0..150], revDamp[0..100], revMix[0..100];
delTime ms[0..1000], delFb[0..95], delTone[0..100], delMix[0..100];
width[0..200], limitOn boolean, ceiling dB[-3..0], outGain dB[-24..24].

Then add two top-level fields:
"_why": 2-4 sentences explaining the chain, referencing the measured numbers you were given.
"_tips": an array of 2-5 short, specific, plain-language tips — INCLUDING any that go beyond these knobs (e.g. regenerate the line with more emotion, add a 200 ms pause before the CTA, vary the pacing) that would push it further toward human.

HOW TO READ THE MEASURED FEATURES (use them — prescribe, don't guess):
- pitchVarSemitones LOW (< ~1.5) = monotone/robotic delivery, the #1 AI tell -> raise wobbleDepth/wobbleMix noticeably (≈25-45 / 30-50) and tip them to re-perform with more inflection.
- bandPct.sibilance high (> ~6%) -> more deEss; low -> keep deEss light (8-20).
- bandPct.low / lowMid heavy (low+lowMid > ~55%) and dull -> trim lows (hpf 80-110, small low-mid dip) and add presence/air.
- spectralCentroid low (< ~1800 Hz) or air low (< ~2%) -> add air (25-40) and a small 6-12k lift; if boomy, tilt slightly positive.
- harsh2to4kPct high -> small dip at 2.5-4k (-2 to -4 dB).
- crestDb very low (< ~8) = already squashed/flat -> little or no compression; crest high (> ~16) -> gentle comp (ratio 2-2.5).
- dynamicRangeDb very low -> avoid more compression; lift with makeup only.
- humHz present (50/60 detected) -> deHum 30-70 and humBase to the detected base.
- noiseFloorDb very low (near silence) -> roomTone 10-18 to humanise; high -> keep roomTone 0-6.
A natural ad-voice chain is usually: gentle hpf, tiny harshness dip, a little warmth, modest air, SMALL asymmetric room (revMix 8-16), light room tone, modest wobble, light de-ess, light comp, and a -1 dB ceiling. Avoid extremes.`;

/* ---------- clamp / validate the model's JSON ---------- */
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
function sanitize(obj) {
  const o = {};
  const map = {
    inGain: [-24, 24], hpf: [20, 400], lpf: [2000, 20000],
    deHum: [0, 100], humBase: [50, 60], tilt: [-100, 100],
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
    } else if (k === "humBase") {
      o.humBase = Number(obj.humBase) >= 55 ? 60 : 50;
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
    endpoints: ["/health", "/api/assist", "/api/transcribe", "/api/mux", "/api/hub/health", "/api/hub/stats"],
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
        '\nTranscript excerpt for prosody/context (do NOT change the words): "' +
        String(transcript).slice(0, 1500) + '"\n';
    userText += "\nReturn the JSON now (settings + _why + _tips).";

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: model || ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: PARAM_DOC,
        messages: [{ role: "user", content: userText }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      stats.errors++;
      return res.status(r.status).json({ error: "anthropic_error", detail: data });
    }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ error: "no_json_in_model_output", raw: text.slice(0, 500) });
    let obj;
    try {
      obj = JSON.parse(m[0]);
    } catch (e) {
      return res.status(502).json({ error: "bad_json_from_model", raw: m[0].slice(0, 500) });
    }
    const why = obj._why || "";
    const tips = Array.isArray(obj._tips) ? obj._tips.map((t) => String(t)).slice(0, 6) : [];
    delete obj._why;
    delete obj._tips;
    stats.assistCalls++;
    res.json({ settings: sanitize(obj), why, tips, model: model || ANTHROPIC_MODEL });
  } catch (err) {
    stats.errors++;
    res.status(500).json({ error: "server_error", detail: String((err && err.message) || err) });
  }
});

/* ----- Whisper: transcribe ----- */
app.post("/api/transcribe", uploadAudio.single("file"), async (req, res) => {
  try {
    const prov = PROVIDERS[WHISPER_PROVIDER] || PROVIDERS.openai;
    const key = prov.key();
    if (!key)
      return res.status(500).json({ error: `No API key for whisper provider "${WHISPER_PROVIDER}". Set ${prov.keyName} on the server.` });
    if (!req.file)
      return res.status(400).json({ error: 'No file uploaded (multipart field name must be "file").' });

    const modelName = req.body.model || prov.model;
    const supportsVerbose = !/gpt-4o/i.test(modelName); // gpt-4o transcribe models only support json/text
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype || "application/octet-stream" }), req.file.originalname || "audio.wav");
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

/* ----- ffmpeg: replace a video's audio with the processed WAV ----- */
app.post(
  "/api/mux",
  uploadMux.fields([{ name: "video", maxCount: 1 }, { name: "audio", maxCount: 1 }]),
  async (req, res) => {
    const files = req.files || {};
    const v = files.video && files.video[0];
    const a = files.audio && files.audio[0];
    const cleanup = (extra = []) => {
      [v && v.path, a && a.path, ...extra].forEach((p) => {
        if (p) try { fs.unlinkSync(p); } catch (_) {}
      });
    };
    if (!v || !a) {
      cleanup();
      return res.status(400).json({ error: "Send multipart fields 'video' and 'audio'." });
    }
    const ext = (path.extname(v.originalname || "") || ".mp4").toLowerCase();
    const isWebm = ext === ".webm";
    const outExt = isWebm ? ".webm" : ".mp4";
    const outPath = path.join(os.tmpdir(), `vox_${crypto.randomBytes(6).toString("hex")}_out${outExt}`);

    const audioCodec = isWebm ? ["-c:a", "libopus"] : ["-c:a", "aac"];
    const baseArgs = (videoArgs) => [
      "-y", "-i", v.path, "-i", a.path,
      "-map", "0:v:0", "-map", "1:a:0",
      ...videoArgs, ...audioCodec, "-b:a", "192k", "-shortest", outPath,
    ];
    const opts = { maxBuffer: 1 << 26, timeout: 5 * 60 * 1000 };

    const send = () => {
      stats.muxCalls++;
      res.download(outPath, "voxforge-export" + outExt, () => cleanup([outPath]));
    };
    // 1) fast path: copy the video stream untouched
    execFile(FFMPEG_PATH, baseArgs(["-c:v", "copy"]), opts, (err) => {
      if (!err) return send();
      // 2) fallback: re-encode video for maximum container compatibility
      const venc = isWebm
        ? ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];
      execFile(FFMPEG_PATH, baseArgs(venc), opts, (err2, _o, stderr2) => {
        if (err2) {
          stats.errors++;
          cleanup([outPath]);
          return res.status(500).json({ error: "ffmpeg_failed", detail: String(stderr2 || err2).slice(0, 600) });
        }
        send();
      });
    });
  }
);

/* ----- optional Finance-Minister hub connector ----- */
function hubAuth(req, res) {
  if (!HUB_API_KEY) { res.status(404).json({ error: "hub_disabled" }); return false; }
  const k = req.get("x-hub-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (k !== HUB_API_KEY) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}
app.get("/api/hub/health", (req, res) => {
  if (!hubAuth(req, res)) return;
  res.json({ status: "ok", service: "voxforge", version: VERSION, uptimeSec: (Date.now() - startedAt) / 1000 });
});
app.get("/api/hub/stats", (req, res) => {
  if (!hubAuth(req, res)) return;
  res.json({ service: "voxforge", version: VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000), ...stats, whisperProvider: WHISPER_PROVIDER });
});

/* error handler -> clean JSON */
app.use((err, _req, res, _next) => {
  const tooBig = /file too large/i.test(String((err && err.message) || ""));
  res.status(tooBig ? 413 : 400).json({
    error: tooBig ? "file_too_large" : "request_error",
    limits: { transcribeMb: MAX_UPLOAD_MB, videoMb: MAX_VIDEO_MB },
    detail: String((err && err.message) || err),
  });
});

app.listen(PORT, () =>
  console.log(`voxforge-backend v${VERSION} on :${PORT} (whisper=${WHISPER_PROVIDER}, ffmpeg=${FFMPEG_PATH})`)
);
