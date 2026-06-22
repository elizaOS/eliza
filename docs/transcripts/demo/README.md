# Transcripts — real-audio e2e demo (#8789)

This directory holds the recorded demo for the transcript feature's real-audio
end-to-end test.

- `demo.mp4` / `demo.gif` — the three `transcript-realaudio` Playwright tests
  recorded back-to-back (capture → viewer → Transcripts/Knowledge), driving the
  REAL `ContinuousChatOverlay` transcript flow with no human and no microphone:
  Chromium is launched with `--use-file-for-fake-audio-capture=known-phrase.wav`,
  so the literal getUserMedia → WAV-encode → POST capture path runs end-to-end.
  Recorded against the shipped UI (the minimal viewer — audio actions sit with
  the player), all 3 tests green.

The spec lives at
[`packages/app/test/ui-smoke/transcript-realaudio.spec.ts`](../../../packages/app/test/ui-smoke/transcript-realaudio.spec.ts)
and runs in the `chromium-voice-mic` Playwright project.

## What is REAL vs mocked

- **REAL:** the injected audio, `getUserMedia`, the WAV encode, the POST bodies
  (`/api/asr/local-inference` carries a >1KB captured WAV; `/api/transcripts`
  carries `audioBase64` of the captured audio), and every client step — the
  ContinuousChatOverlay, the transcript session accumulator, the attachment, the
  editable viewer, the Transcripts player, and the Knowledge link.
- **Mocked:** the ASR / transcript-store / media / knowledge / conversation
  BACKENDS (not provisioned in CI), via Playwright `page.route`.

## Reproduce

```bash
E2E_RECORD=1 node packages/app/scripts/run-ui-playwright.mjs \
  --config playwright.ui-smoke.config.ts \
  --project=chromium-voice-mic transcript-realaudio
```

(`ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1` skips the plugin-view rebuild once it's warm.)
The webServer cold-builds the renderer (~12 min, capped at 18).
