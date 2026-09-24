# voice-kokoro-tts

Pinned Docker service for the Cloud voice route `/api/tts`. Kokoro accepts JSON `{ text, voice, speed }` and returns WAV audio.
The server must bind Railway's assigned `PORT`; readiness is `/health`.

Set the Worker `KOKORO_TTS_URL` and repository variable `ELIZA_VOICE_KOKORO_TTS_URL`
to the deployed service URL. From this directory:

```bash
# Build
docker build -t eliza-kokoro-tts .
# Deploy when authorized
railway up . --path-as-root --service kokoro-tts
```

Test both deployed voice services from the repository root (requires reachable
`KOKORO_TTS_URL` and `WHISPER_STT_URL`):

```bash
ELIZA_VOICE_LIVE_RAILWAY=1 bun test packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts
```
