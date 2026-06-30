# VOXFORGE — Backend (v2)

The brain behind VOXFORGE. It keeps your API keys off the browser and exposes what the studio needs:

- **`POST /api/assist`** — sends your voice description + measured audio features (including a monotone/pitch-variance score) to Claude and returns a full set of suggested processing settings (validated/clamped), a rationale, and a list of plain-language **tips** to push the voice further toward human.
- **`POST /api/transcribe`** — runs **Whisper** (OpenAI or Groq). The frontend now sends a small 16 kHz mono clip, so the old `file_too_large` error is gone.
- **`POST /api/mux`** — **NEW.** Takes your original **video** + the **processed WAV** and uses **ffmpeg** to swap the audio in, returning a finished video. The video stream is copied untouched (lossless, fast); it only re-encodes as a fallback if a container needs it. This powers **Export video** in the UI.

Plus `GET /health` and an optional Finance-Minister hub connector (`/api/hub/health`, `/api/hub/stats`).

Stack: Node 20 + Express + ffmpeg. Deploys on Railway with zero config — `nixpacks.toml` installs ffmpeg for you.

---

## Environment variables

Add these in Railway → your backend service → **Variables**.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | — | Your Claude key (`sk-ant-…`). Powers `/api/assist`. |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-6` | Model used if the frontend doesn't send one. |
| `WHISPER_PROVIDER` | No | `openai` | `openai` or `groq`. |
| `OPENAI_API_KEY` | If provider=openai | — | For `/api/transcribe`. |
| `OPENAI_MODEL` | No | `whisper-1` | OpenAI transcription model. |
| `GROQ_API_KEY` | If provider=groq | — | For `/api/transcribe` (fast + cheap). |
| `GROQ_MODEL` | No | `whisper-large-v3` | Groq transcription model. |
| `ALLOWED_ORIGIN` | No | `*` | Your frontend URL for CORS (comma-separated for several). Lock this down for production. |
| `MAX_UPLOAD_MB` | No | `25` | Max transcription clip size. The frontend downsamples to ~1.9 MB/min, so this is plenty. |
| `MAX_VIDEO_MB` | No | `200` | **NEW.** Max video size accepted by `/api/mux`. Raise if your ad videos are large. |
| `FFMPEG_PATH` | No | `ffmpeg` | **NEW.** Path to the ffmpeg binary. Default works on Railway (installed via `nixpacks.toml`). |
| `HUB_API_KEY` | No | — | Set it to enable the hub endpoints. Send the same value as header `x-hub-key`. |
| `PORT` | Auto | `8080` | Railway sets this automatically. |

> **ffmpeg:** the included `nixpacks.toml` adds `ffmpeg` at build time, so video export works on Railway out of the box. If you deploy elsewhere, make sure ffmpeg is on the PATH (or set `FFMPEG_PATH`).
> **Whisper choice:** `openai` is the simplest. **`groq`** is dramatically faster and cheaper for the same `whisper-large-v3` model — flip `WHISPER_PROVIDER=groq` and add `GROQ_API_KEY` if you transcribe a lot.


---

## Deploy on Railway

1. Push this folder to its own GitHub repo (e.g. `voxforge-backend`).
2. Railway → **New Project → Deploy from GitHub repo** → pick it.
3. Add the variables above (at minimum `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` if you want transcription).
4. Railway builds and starts it (`npm start`). Under **Settings → Networking**, click **Generate Domain**.
5. Copy that public URL — you'll paste it into the frontend as `VITE_API_URL`.
6. Once the frontend is live, set `ALLOWED_ORIGIN` to the frontend's URL and redeploy.

Health check: open `https://<your-backend>.up.railway.app/health` → `{ "ok": true }`.

---

## Run locally

```bash
cp .env.example .env      # fill in your keys
npm install
npm run dev               # http://localhost:8080
```

Quick test:

```bash
curl -X POST http://localhost:8080/api/assist \
  -H 'content-type: application/json' \
  -d '{"description":"robotic ElevenLabs male voice, harsh S sounds, no room"}'
```

---

## Endpoints

**POST `/api/assist`** — JSON body:
```json
{ "description": "string", "model": "claude-sonnet-4-6", "features": { ... }, "transcript": "string" }
```
Returns: `{ "settings": { ...validated chain... }, "why": "rationale" }`

**POST `/api/transcribe`** — `multipart/form-data` with field **`file`** (audio or mp4/mov/webm).
Returns: `{ "text": "...", "segments": [{start,end,text}], "provider": "openai" }`

**GET `/api/hub/health`**, **GET `/api/hub/stats`** — require header `x-hub-key: <HUB_API_KEY>` (404 if `HUB_API_KEY` unset).
