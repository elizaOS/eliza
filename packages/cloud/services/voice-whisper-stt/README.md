# voice-whisper-stt (free-cloud Whisper STT)

Self-hosted Whisper STT behind the cloud-api `/api/v1/voice/stt` route (the
`WHISPER_STT_URL` branch — the free, unbilled default transcription path). It
wraps the upstream [Speaches](https://github.com/speaches-ai/speaches) image
(OpenAI-compatible, formerly faster-whisper-server); the CTranslate2 model is
fetched from Hugging Face while the image is built, so there are no secrets and
a healthy deployment already contains the model required by the route.

## Contract (do not break — the live test asserts it)

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/v1/audio/transcriptions` | multipart: `file`, `model`, optional `language` | JSON `{ text }` |
| `GET` | `/health` | — | `200` |

The `model` id is `resolveWhisperSttModel(WHISPER_STT_MODEL)`, defaulting to the
multilingual `Systran/faster-whisper-small`
(`packages/cloud/api/v1/voice/stt/whisper-model.ts`). The Dockerfile's
`WHISPER_MODEL` build argument installs that same model — keep the two in sync.
The exact request shape is asserted by
`packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts`.

## Deploy (owner action)

The service is pinned in-repo (`Dockerfile` + `railway.toml`):

```bash
railway up . --path-as-root --service whisper-stt  # from packages/cloud/services/voice-whisper-stt
```

Railway assigns a deployment-specific `PORT`; the image launcher passes that
value to Uvicorn explicitly so `/health` and public traffic use the same socket.
Do not rely on Speaches' fixed `UVICORN_PORT=8000` image default.

After deploy, set `WHISPER_STT_URL` (cloud-api Worker env / `wrangler secret`)
to the public URL, optionally `WHISPER_STT_MODEL` to pin a different hosted
model, and set the repo variable `ELIZA_VOICE_WHISPER_STT_URL` to the same URL.

CUDA variant on a GPU-backed plan:

```bash
railway up . --path-as-root --service whisper-stt \
  --build-arg WHISPER_IMAGE=ghcr.io/speaches-ai/speaches:0.8.2-cuda
```

## Scheduled live contract lane

`voice-kokoro-whisper-live.test.ts` was referenced by zero workflows, so a dead
service surfaced only as a user report. It now runs in the **voice-railway-contract**
job of `.github/workflows/voice-live-e2e.yml` (nightly + `workflow_dispatch`),
env-gated on `ELIZA_VOICE_LIVE_RAILWAY=1`. The job reads the two service URLs
from repo variables `ELIZA_VOICE_KOKORO_TTS_URL` / `ELIZA_VOICE_WHISPER_STT_URL`
(falling back to the test defaults), so drift or death of either service is a red
run instead of a silent outage.
