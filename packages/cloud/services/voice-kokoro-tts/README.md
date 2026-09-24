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

Test deployment contracts from the repository root:

```bash
bun test packages/scripts/__tests__/voice-railway-service-defs.test.ts
```
