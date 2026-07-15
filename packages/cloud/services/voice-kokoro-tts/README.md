# voice-kokoro-tts (free-cloud Kokoro TTS)

Self-hosted Kokoro TTS behind the cloud-api `/api/v1/voice/tts` route (the
`KOKORO_TTS_URL` branch — the free, unbilled default voice path). It wraps the
upstream [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) image; the
weights ship in the image, so there are no secrets.

Pinned Kokoro-FastAPI exposes `/v1/audio/speech`; `eliza_kokoro_compat.py`
adapts the existing cloud-api `/api/tts` body to that typed upstream request.
Keep this adapter until every deployed cloud-api caller uses the new contract.

## Contract (do not break — the live test asserts it)

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/api/tts` | JSON `{ text, voice, speed }` | `audio/wav` (RIFF/WAVE) |
| `GET` | `/health` | — | `200` |

The eleven allowlisted `voice` presets (default `af_heart`) are the Kokoro voice
ids `packages/cloud/api/v1/voice/tts/route.ts` sends. The exact round-trip is
asserted by `packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts`,
run in the scheduled **Voice Live E2E → voice-railway-contract** lane
(`.github/workflows/voice-live-e2e.yml`).

## Deploy (owner action)

The service is pinned in-repo (`Dockerfile` + `railway.toml`). To deploy or
redeploy from this directory:

```bash
railway up . --path-as-root --service kokoro-tts  # from packages/cloud/services/voice-kokoro-tts
```

Railway assigns a deployment-specific `PORT`; the image launcher binds Uvicorn
to that value so `/health` is checked on the same socket that serves traffic.
Do not restore the upstream launch command, which hard-codes port `8880`.

After deploy, point cloud-api at it by setting `KOKORO_TTS_URL` (Worker env /
`wrangler secret`) to the service's public URL, and set the same URL as the repo
variable `ELIZA_VOICE_KOKORO_TTS_URL` so the scheduled contract lane targets the
live deploy (see `../voice-whisper-stt/README.md` for the shared lane wiring).

Build a GPU variant on a GPU-backed plan by overriding the pinned image:

```bash
railway up . --path-as-root --service kokoro-tts \
  --build-arg KOKORO_IMAGE=ghcr.io/remsky/kokoro-fastapi-gpu:v0.2.2
```
