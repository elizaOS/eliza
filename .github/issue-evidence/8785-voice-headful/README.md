# #8785 — Headful voice validation (desktop / web)

Human-verifiable proof that the voice assistant works end-to-end through the
**real frontend client pipeline** (capture → ASR → agent SSE → TTS → playback)
in a real browser. Captured by Playwright (`E2E_RECORD=1`, Chromium) on
2026-06-22; every artifact here is from a run that **passed**.

## Result

```
13 passed (5.3m)   — packages/app/test/ui-smoke/voice-*.spec.ts (ui-smoke config, E2E_RECORD)
```

Adversarially reviewed (14-agent workflow, one skeptic per screenshot):
**all 13 genuine passes, 0 false-green.** Confirmed real ASR latency (not
stubbed), WER 0 transcript match, and correct **negative-path** discrimination
(mid-utterance + bystander turns correctly NOT responded).

## What each artifact shows

| File | What it proves |
| --- | --- |
| `voice-realaudio-mic-roundtrip.webm` / `…-pletes-the-voice-round-trip.png` | **REAL injected mic audio** via `getUserMedia` + `--use-file-for-fake-audio-capture` → real local-ASR recorder → agent → TTS. Transcript "what time is it" (WER 0), reply "It is noon.", TTS via `/api/tts/cloud`. The closest thing to a live human round-trip. |
| `voice-selftest-stt-agent-tts-roundtrip.webm` / `voice-selftest-e2e-…-round-trip.png` | Full STT→agent→TTS self-test, `overall: pass`, per-stage timings (asr/send/tts). |
| `voice-desktop-selftest-…-local-inference-TTS-route.png` | Desktop self-test uses the local-inference TTS route. |
| `voice-workbench-respond-decision.webm` / `voice-workbench-respond-no-…-mix.png` | Respond-decision: owner turns responded, **bystander turns NOT** — per-turn `[pass]` with `responded` matching ground truth. |
| `voice-workbench-eot-…-thought.png` | EOT: mid-utterance fragment NOT responded; final fragment responded. |
| `voice-workbench-{diarization,multi-speaker,multi-voice}-….png` | Per-speaker turn attribution, transcripts match, WER 0. |
| `voice-workbench-{entity-extraction,voice-recognition}-….png` | Name → entity extraction + owner voice recognition. |
| `voice-workbench-{multi-agent-room,pauses,transcription}-….png` | Multi-agent addressing, pauses-not-EOT, transcription-mode (no response). |

## Reproduce

```bash
cd packages/app
E2E_RECORD=1 node scripts/run-ui-playwright.mjs \
  --config playwright.ui-smoke.config.ts voice-
# → e2e-recordings/app/test-results/<spec>/{video.webm,trace.zip,test-finished-1.png}
# open a trace: npx playwright show-trace e2e-recordings/app/test-results/<spec>/trace.zip
```

Backends are mocked in this lane (deterministic, keyless) — it validates the
real **client pipeline + player + respond/EOT/diarization decisions through the
DOM**, not acoustic model accuracy (that is the gated `--real` lane; see
[../../../plugins/plugin-local-inference/src/services/voice/research/VOICE_VALIDATION_RUNBOOK.md](../../../plugins/plugin-local-inference/src/services/voice/research/VOICE_VALIDATION_RUNBOOK.md)).
The full 13-video + 13-trace set is under the gitignored `e2e-recordings/`.
