# Onboarding voice presets

Pre-generated WAVs spoken during first-run onboarding, before any agent or
downloaded model exists. The first-run TTS route (`/api/tts/first-run/speak`)
serves these by line id (see `src/api/onboarding-voice-lines.ts`); until a
preset exists the route returns 404 and the UI falls back to browser speech.

Generate (requires a downloaded Eliza-1 bundle with the OmniVoice model):

```
bun packages/app-core/scripts/voice-preset/build-onboarding-voice.mjs \
  --bundle ~/.milady/models/eliza-1/<bundle>
```

This writes `<id>.wav` per line plus `manifest.json` into this directory.
