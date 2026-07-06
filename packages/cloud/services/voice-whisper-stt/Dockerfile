# Reproducible build of the free-cloud Whisper STT service that lives behind the
# cloud-api /api/v1/voice/stt route (the `WHISPER_STT_URL` branch). It wraps the
# upstream Speaches (formerly faster-whisper-server) image so the deploy is a
# pinned, in-repo artifact instead of an unreproducible Railway pet: the
# previously-provisioned instance (whisper-stt-production-6fc7.up.railway.app)
# existed only as a test-default URL.
#
# Contract this image MUST satisfy (asserted by
# packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts):
#   POST /v1/audio/transcriptions  (multipart: file, model, [language])
#        -> { text }   (OpenAI-compatible transcription response)
#   GET  /health       -> 200 (Railway healthcheck, see railway.toml)
# The `model` id the route sends is resolveWhisperSttModel(WHISPER_STT_MODEL),
# defaulting to the multilingual Systran/faster-whisper-small — Speaches lazily
# downloads that CTranslate2 model on first use, so WHISPER__MODEL below warms it
# at boot to keep the first live request from timing out.
#
# Pin: Speaches publishes CPU/CUDA variants under ghcr.io/speaches-ai/speaches.
# CPU is the Railway default (free tier has no GPU); override WHISPER_IMAGE at
# build time for a CUDA variant on a GPU-backed plan. Bump the tag deliberately —
# an unpinned :latest is exactly the drift this issue removes. The tag must be a
# real published manifest AND still expose the contract below (0.8.x keeps
# POST /v1/audio/transcriptions with multipart field `file` and GET /health);
# verify the ghcr manifest exists before bumping.
ARG WHISPER_IMAGE=ghcr.io/speaches-ai/speaches:0.8.2-cpu

FROM ${WHISPER_IMAGE}

# Warm the default multilingual model at boot so the first transcription does not
# eat a cold model download. Must track DEFAULT_WHISPER_STT_MODEL in
# packages/cloud/api/v1/voice/stt/whisper-model.ts.
ENV WHISPER__MODEL=Systran/faster-whisper-small

# Railway injects PORT; kept explicit so the railway.toml healthcheck and EXPOSE
# agree with the runtime bind.
ENV PORT=8000
EXPOSE 8000
