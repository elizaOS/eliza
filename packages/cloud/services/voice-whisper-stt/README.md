# voice-whisper-stt

Optional self-hosted Whisper service for `/v1/audio/transcriptions`. It accepts multipart audio and returns JSON `{ text }`.
The server binds `PORT`; readiness is `/health`.
Managed Cloud voice uses Workers AI: Aura-2 for TTS and Nova-3 for transcription.

Build locally from this directory:

```bash
docker build -t eliza-whisper-stt .
```

To test self-hosted compatibility, set both `KOKORO_TTS_URL` and `WHISPER_STT_URL`
to your services, then run from the repository root:

```bash
ELIZA_VOICE_LIVE_RAILWAY=1 bun test packages/cloud/api/__tests__/voice-kokoro-whisper-live.test.ts
```

The legacy opt-in flag is retained for workflow compatibility. There are no default service URLs.
