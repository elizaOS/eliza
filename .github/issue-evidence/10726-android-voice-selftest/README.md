# #10726 — On-device voice self-test, Pixel 6a

Real on-device run of the in-app Voice self-test (`wav-direct` mode) on a
**physical Pixel 6a**, to answer this issue's item #2 — *"verify whisper/omnivoice
actually load and run on Android."* Answer: **they do.** Also captures two honest
caveats (a shallow pass criterion and slow latency).

## Result — `overall: pass`

```
platform=android · ttsRoute=/api/tts/local-inference · phrase="what time is it"
[pass] asr  (31321 ms)   mode=wav-direct  transcript="What time is it?"  wer=0  (tol 0.34)
[pass] send (284 ms)
[pass] tts  (56580 ms)
reply: "Sorry, I'm having a provider issue"
```

## What this verifies (positive)

- **On-device ASR loads and transcribes correctly** — the bundled WAV was
  transcribed to `"What time is it?"` with **WER 0** against the expected phrase.
  The local-inference ASR path (whisper/omnivoice) genuinely runs on Android.
- **On-device TTS synthesizes** — the TTS stage produced audio via
  `/api/tts/local-inference`.
- Earlier in testing the same probe reported `asr: skipped — "local-inference ASR
  not ready on this host"`. That was a **model-load-timing artifact**, not a
  broken path: once the model finished loading, the identical test passes. (Worth
  a "warming up" vs "unavailable" distinction in the readiness signal so callers
  don't treat a still-loading model as absent.)

## Honest caveats (candidates for this issue's de-larp / STT-quality scope)

1. **The pass is stage-level, not conversational.** `send` and `tts` are green,
   but the actual `reply` was `"Sorry, I'm having a provider issue"` (no chat LLM
   configured on this fresh device) — and TTS happily synthesized that error
   string. The voice *pipeline* works; the end-to-end *answer* did not. A
   self-test that reports `pass` while the reply is a provider-error is exactly
   the shallow-validation pattern this issue targets — asserting stage mechanics,
   not the semantic outcome. Consider a stage that fails/flags when the reply is a
   known error-fallback.
2. **Latency is high on-device:** ASR **31.3 s** + TTS **56.6 s** for a
   4-word phrase / short reply (~88 s wall). Real, measured — relevant to this
   issue's STT-latency/model-selection scope and to the perf epic #10724.

## Device / build

Physical Pixel 6a (bluejay), `ai.elizaos.app` debug (2026-06-30 build). Device
clock is skewed (~March); the `startedAt`/`finishedAt` timestamps reflect that,
not the run date. Screenshot: `voice-selftest-pass-pixel6a.png`.
