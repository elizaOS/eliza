# Reproducible build of the free-cloud Kokoro TTS service that lives behind the
# cloud-api /api/v1/voice/tts route (the `KOKORO_TTS_URL` branch). It wraps the
# upstream Kokoro-FastAPI image so the deploy is a pinned, in-repo artifact
# instead of an unreproducible Railway pet: the previously-provisioned instance
# (kokoro-tts-production-aa4b.up.railway.app) existed only as a test-default URL.
#
# Contract this image MUST satisfy (asserted by
# packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts):
#   POST /api/tts  { text, voice, speed } -> audio/wav (RIFF/WAVE)
#   GET  /health   -> 200 (Railway healthcheck, see railway.toml)
# The eleven allowlisted voice presets (af_heart default, …) are the Kokoro
# voice ids the route sends; they ship with the upstream image's voice pack.
#
# Pin: upstream publishes CPU/GPU variants under ghcr.io/remsky/kokoro-fastapi-*.
# CPU is the Railway default (the free tier has no GPU); override KOKORO_IMAGE at
# build time to repoint at a GPU variant on a GPU-backed Railway plan. Bump the
# tag deliberately — an unpinned :latest is exactly the drift this issue removes.
ARG KOKORO_IMAGE=ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.2

FROM ${KOKORO_IMAGE}

# Railway injects PORT; the upstream server reads it. Kept explicit so the
# healthcheck URL in railway.toml and the EXPOSE line agree with the runtime.
ENV PORT=8880
EXPOSE 8880
