# STT selection decision — per-device, backed by measured numbers

Issue #11337 (parent #10726, Pillar 3) requires that the STT model/backend
choice per device is **benchmarked and documented**, not just hard-coded. This
file is that decision record. The runtime heuristic that implements it is
`pickDefaultVoiceProvider` in [`voice-provider-defaults.ts`](./voice-provider-defaults.ts)
(plus the capture-time readiness downgrade `isLocalInferenceAsrReady` →
browser fallback in `voice-capture-factory.ts` / `local-asr-transcribe.ts`).

## Candidate backends

| Backend | What it is | Where it can run |
| --- | --- | --- |
| **fused local ASR** (`local-inference`) | eliza-1-asr GGUF (Qwen3-ASR family, ~1.0 GB main+mmproj) through the fused `libelizainference` FFI | Linux/macOS/Windows desktop, Android (heavy), iOS (heavy) |
| **`SFSpeechRecognizer`** | Apple on-device recognizer (ANE/CPU, `requiresOnDeviceRecognition=true`) | macOS / iOS only (OS engine, not an `AsrProvider` — reachable via the native talkmode bridge) |
| **Android `SpeechRecognizer`** | Android OS recognizer (NNAPI) | Android only (OS engine, not an `AsrProvider` — reachable via the native talkmode bridge) |
| **Browser `SpeechRecognition`** | Web Speech API, engine-dependent (often server-backed) | any browser shell; capture-time fallback only |
| **Eliza Cloud ASR** (`eliza-cloud`) | server-side transcription via the cloud API | anywhere with connectivity |

## Measured numbers (committed evidence)

All fused-ASR numbers are real-weight runs — no mocks; lanes fail closed under
their `*_REQUIRE=1` flags.

| Backend | Device | Corpus | WER | Latency / RTF | Evidence |
| --- | --- | --- | ---: | --- | --- |
| fused eliza-1-asr (bundle-2b) | Linux x86-64, CPU-only | 12 Kokoro utterances, 55.5 s, labelled transcripts | **0.008 mean / 0.000 median** | 1213 ms/utt mean, **RTF 0.262 (3.8× realtime)**, load 1851 ms | [`10726-noise-stt-suites-2026-07-02/stt-quant-bench.md`](../../../../.github/issue-evidence/10726-noise-stt-suites-2026-07-02/stt-quant-bench.md) (PR #11388, `sttquant:real`) |
| fused eliza-1-asr, noise variants | Linux x86-64, CPU-only | same corpus + white/pink/music/babble at 20…−5 dB SNR | 0.008 clean; ≤ 0.04 at 10 dB (white/pink), 0.039 (babble); collapses only below 0 dB babble | — | [`10726-noise-stt-suites-2026-07-02/noise-rejection.md`](../../../../.github/issue-evidence/10726-noise-stt-suites-2026-07-02/noise-rejection.md) (`noise:real`) |
| fused eliza-1-asr | Linux x86-64, CPU-only | `freeman.wav` (real recorded human speech, 39 words) | accurate (all sentences correct) | 13.1 s for the clip on the current-fork lib | [`10726-host-voice-lanes-linux-2026-07-02.md`](../../../../.github/issue-evidence/10726-host-voice-lanes-linux-2026-07-02.md) (`test:asr:real`) |
| `SFSpeechRecognizer` (on-device) | Apple silicon (darwin arm64) | 5 labelled utterances, quiet | **0.0 % WER**, 100 % exact-accept | 243 ms mean (p50 80 ms), **RTF 0.168** | [`9958-stt-stage-b-eval/stage-b-stt-eval.md`](../../../../.github/issue-evidence/9958-stt-stage-b-eval/stage-b-stt-eval.md) (`stage-b-stt-bench.mjs`) |
| `SFSpeechRecognizer` (on-device) | Apple silicon (darwin arm64) | same, white noise at 10 dB SNR | 4.0 % WER, 80 % exact-accept | 352 ms mean, RTF 0.245 | same |
| fused eliza-1-asr | **Pixel 6a (physical device)** | 1 bundled utterance ("what time is it") | WER 0 (single utterance — bring-up proof, not a benchmark) | asr stage 31.3 s **including model load**; steady-state RTF unmeasured | [`10726-android-voice-selftest/README.md`](../../../../.github/issue-evidence/10726-android-voice-selftest/README.md) |
| Android `SpeechRecognizer` (NNAPI) | — | — | **needs-hardware** | needs-hardware | Stage-B gate below |
| Browser `SpeechRecognition` | — | — | engine-dependent, no committed measurement | — | fallback only |
| Eliza Cloud ASR | server-side | — | no committed WER benchmark (network-dependent latency) | — | default where local can't run |

Corpus caveat: the 12-utterance corpus is synthesized with real Kokoro TTS from
fixed transcripts, so absolute WER carries a small TTS-pronunciation floor;
cross-condition/cross-quant deltas are the signal. The freeman.wav row and the
Apple rows are real recorded / OS-synthesized speech.

## Decision (per platform × runtime mode)

| Platform | Runtime | ASR default | Decision + rationale | Matches heuristic? |
| --- | --- | --- | --- | --- |
| Desktop (Linux/macOS/Windows) | local / local-only | `local-inference` | **Fused eliza-1-asr wins where provisioned**: measured WER 0.008 at 3.8× realtime on plain desktop CPU, robust to ≥ 10 dB SNR noise, fully offline. No candidate beats it on quality here, and it's the only offline option on Linux/Windows. If the bundle isn't provisioned, `isLocalInferenceAsrReady` degrades capture to the browser engine at runtime. | ✅ yes |
| Mobile (Android/iOS) | local / local-only | `eliza-cloud` | The 1.0 GB fused model **runs** on Android (Pixel 6a WER 0 bring-up) but the only on-device measurement is 31.3 s including load, with steady-state RTF/battery unmeasured — not evidence of a good interactive default. Cloud ASR keeps latency predictable while the on-device Stage-B numbers are missing. Revisit when the Stage-B matrix (below) lands measured on-device RTF/battery. | ✅ yes |
| Web shell | local | `eliza-cloud` | A browser tab hosting a local agent has no fused FFI runtime; the Web Speech API is engine-dependent and unmeasured. Cloud is the deterministic choice. | ✅ yes |
| any | cloud / remote | `eliza-cloud` | Agent isn't on this machine; audio must go to the server anyway. | ✅ yes |
| macOS/iOS wake-confirm (Stage-B) | — | `SFSpeechRecognizer` | Measured WER 0 quiet / RTF 0.168 on Apple silicon makes it the cheapest-correct confirm recognizer on Apple (VOICE_UX.md §7). This is a talkmode-bridge engine, not an `AsrProvider` value, so it does not change `pickDefaultVoiceProvider`. | n/a (outside the provider enum) |

**Conclusion for #11337 AC "wired back into `pickDefaultVoiceProvider` if the
measured winner differs":** the measured winners do **not** differ from the
platform heuristic — fused local ASR wins on desktop when provisioned (and the
heuristic already prefers it), and no committed measurement justifies flipping
mobile/web away from cloud. No code change required; this doc is the evidence
link the heuristic previously lacked.

**Measurable quality improvements recorded** (parent AC): TTS WER 1.00 → 0.13
(Kokoro double-phonemization fix, PR #11238); STT noise-rejection and quant
benches established the 0.008-WER baseline with pass gates (PR #11388) so any
regression is now measurable.

## How the missing rows get measured (device-gated engines)

The remaining unmeasured cells are OS engines that only exist on provisioned
hardware. They are benchmarked through the **Stage-B** machinery, not ad-hoc
scripts (schema and gates in [`VOICE_LIVE_MATRIX.md`](./VOICE_LIVE_MATRIX.md)):

- **macOS/iOS `SFSpeechRecognizer`** — `node packages/scripts/stage-b-stt-bench.mjs`
  on a macOS host (cell `stt.stage-b.apple-sfspeech`; Apple-silicon run already
  committed). iOS battery/energy telemetry still needs a real iOS device +
  Instruments.
- **Android `SpeechRecognizer` (NNAPI)** — needs a port of `stage-b-stt-bench`
  to an instrumented Android test on a real device (coordinate with #10727
  device lifecycle and the `voice-live-e2e.yml` runner).
- **Fused ASR on-device (steady-state)** — `bun plugins/plugin-local-inference/native/verify/asr_bench.ts
  --wav-dir <corpus> --real-recorded` on the provisioned device bundle.
- The combined decision cell `stt.stage-b.evaluation` goes green only when
  `packages/scripts/voice-stage-b-eval.mjs` validates a reviewed
  `eliza_voice_stage_b_stt_eval_v1` report covering `ios-sfspeechrecognizer`,
  `android-speechrecognizer`, and `fused-asr` with real hardware, latency, WER,
  and power telemetry:
  `ELIZA_VOICE_STAGE_B_REPORT=<report.json> bun run voice:matrix -- --run --platform stt.stage-b.evaluation`.

## How to benchmark additional model candidates

`plugins/plugin-local-inference/scripts/stt-quant-bench-real.ts`
(`bun run --cwd plugins/plugin-local-inference sttquant:real`) already accepts
arbitrary extra candidates via env:

- `ELIZA_ASR_QUANT_DIR` — a directory of `eliza-1-asr-<quant>.gguf` files plus a
  shared `eliza-1-asr-mmproj.gguf`; every quant becomes a table row.
- `ELIZA_ASR_BUNDLE` — the shipped bundle layout (`asr/eliza-1-asr.gguf`), the
  row mobile provisioning actually stages.
- `STT_BENCH_MAX_BEST_WER` — sanity ceiling for the best row (default 0.5);
  `STT_BENCH_REQUIRE=1` turns skips into failures.

Only the shipped 2b quant is published on `elizaos/eliza-1` today, so the
committed table has one row; new quants populate it with zero harness changes.
When a new row beats the current default on WER **and** RTF for a device tier,
update the decision table here and (if the winning backend changes) the
heuristic + its unit tests together.
