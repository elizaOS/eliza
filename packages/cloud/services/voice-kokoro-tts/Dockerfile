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

# Kokoro-FastAPI v0.2.2 exposes only /v1/audio/speech. Cloud-api's stable free
# voice contract remains /api/tts, so the derived image owns that typed adapter.
# Its complete-audio path omits the required voice during text chunking; the
# streaming WAV path is the upstream-supported path that preserves the voice.
COPY --chown=appuser:appuser eliza_kokoro_compat.py /app/eliza_kokoro_compat.py

# Railway replaces this default with its deployment-specific PORT. The upstream
# entrypoint hard-codes 8880, so the command below must expand PORT at runtime or
# Railway probes a different socket and rejects an otherwise-running deploy.
ENV PORT=8880
EXPOSE 8880

# Preserve the upstream model-download behavior while binding Uvicorn to the
# same runtime port Railway uses for health checks and public routing.
CMD ["sh", "-c", "if [ \"$DOWNLOAD_MODEL\" = \"true\" ]; then python download_model.py --output api/src/models/v1_0; fi; exec uv run --extra \"$DEVICE\" python -m uvicorn eliza_kokoro_compat:app --host 0.0.0.0 --port \"$PORT\" --log-level debug"]
