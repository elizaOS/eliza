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

Test both deployed voice services from the repository root (requires reachable
`KOKORO_TTS_URL` and `WHISPER_STT_URL`):

```bash
ELIZA_VOICE_LIVE_RAILWAY=1 bun test packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts
```
