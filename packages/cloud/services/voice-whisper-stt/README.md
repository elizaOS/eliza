# voice-whisper-stt (free-cloud Whisper STT)

Self-hosted Whisper STT behind the cloud-api `/api/v1/voice/stt` route (the
`WHISPER_STT_URL` branch — the free, unbilled default transcription path). It
wraps the upstream [Speaches](https://github.com/speaches-ai/speaches) image
(OpenAI-compatible, formerly faster-whisper-server); the CTranslate2 model is
fetched from Hugging Face while the image is built, so there are no secrets and
a healthy deployment already contains the model required by the route.

## Service contract

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/v1/audio/transcriptions` | multipart: `file`, `model`, optional `language` | JSON `{ text }` |
| `GET` | `/health` | — | `200` |

The `model` id is `resolveWhisperSttModel(WHISPER_STT_MODEL)`, defaulting to the
multilingual `Systran/faster-whisper-small`
(`packages/cloud/api/v1/voice/stt/whisper-model.ts`). The Dockerfile's
`WHISPER_MODEL` build argument installs that same model — keep the two in sync.
Application tests use the perfect-result provider at the inference boundary.
They do not certify a deployed Whisper service.

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

## Automated tests

The shared `.github/workflows/e2e.yml` suite uses deterministic transcription
and speech results. Service availability and acoustic quality require separate
operator verification; the retired live-smoke workflow provides no such evidence.
