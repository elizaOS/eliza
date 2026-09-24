# voice-whisper-stt

Pinned Docker service for the Cloud voice route `/v1/audio/transcriptions`. Whisper accepts multipart audio and returns JSON `{ text }`. Keep the Docker model aligned with `WHISPER_STT_MODEL`.
The server must bind Railway's assigned `PORT`; readiness is `/health`.

Set the Worker `WHISPER_STT_URL` and repository variable `ELIZA_VOICE_WHISPER_STT_URL`
to the deployed service URL. From this directory:

```bash
# Build
docker build -t eliza-whisper-stt .
# Deploy when authorized
railway up . --path-as-root --service whisper-stt
```

Test deployment contracts from the repository root:

```bash
bun test packages/scripts/__tests__/voice-railway-service-defs.test.ts
```
