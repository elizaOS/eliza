# Stage-B on-device STT evaluation — Apple SFSpeechRecognizer arm (#9958)

Generated: 2026-06-30T04:58:46.700Z
Host: darwin arm64 (Mac.localdomain)
Recognizer: `SFSpeechRecognizer` locale en-US, requiresOnDeviceRecognition=true, supportsOnDeviceRecognition=true
Speech source: on-device Apple TTS (`say -v Samantha`) at 16000 Hz mono; noisy condition = white noise mixed at 10 dB SNR

## Backend × condition matrix

| Backend | Condition | Utts | Exact-accept | Mean WER | Mean latency | p50 | p90 | Mean RTF | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| apple-sfspeechrecognizer (on-device) | quiet | 5 | 100.0% | 0.0% | 243 ms | 80 ms | 844 ms | 0.168 | measured |
| apple-sfspeechrecognizer (on-device) | noisy-10dB | 5 | 80.0% | 4.0% | 352 ms | 110 ms | 1267 ms | 0.245 | measured |
| android `SpeechRecognizer` (NNAPI) | quiet/noisy | — | — | — | — | — | — | — | **device handoff** |
| fused libelizainference ASR (Whisper-family) | quiet/noisy | — | — | — | — | — | — | — | **runtime handoff** |

### Per-utterance — quiet

| id | reference | hypothesis | WER | latency | RTF |
|---|---|---|---:|---:|---:|
| utt-01 | turn on the kitchen lights | Turn on the kitchen lights | 0.0% | 844 ms | 0.596 |
| utt-02 | set a reminder for tomorrow morning | Set a reminder for tomorrow morning | 0.0% | 155 ms | 0.080 |
| utt-03 | what time is it in tokyo | What time is it in Tokyo | 0.0% | 74 ms | 0.049 |
| utt-04 | open the front door | Open the front door | 0.0% | 60 ms | 0.057 |
| utt-05 | thanks that is all for now | Thanks that is all for now | 0.0% | 80 ms | 0.056 |

### Per-utterance — noisy-10dB

| id | reference | hypothesis | WER | latency | RTF |
|---|---|---|---:|---:|---:|
| utt-01 | turn on the kitchen lights | Turn on the kitchen light | 20.0% | 1267 ms | 0.895 |
| utt-02 | set a reminder for tomorrow morning | Set a reminder for tomorrow morning | 0.0% | 194 ms | 0.100 |
| utt-03 | what time is it in tokyo | What time is it in Tokyo | 0.0% | 90 ms | 0.059 |
| utt-04 | open the front door | Open the front door | 0.0% | 100 ms | 0.095 |
| utt-05 | thanks that is all for now | Thanks that is all for now | 0.0% | 110 ms | 0.077 |

## Methodology

- Real speech is synthesised on-device with Apple TTS for each labelled reference in
  `asr_bench_fixtures/non_publish_structure_5utt/manifest.json` (the checked-in WAVs there are
  deterministic tones, not speech — this regenerates the matching speech the manifest's own
  `requiredPublishReplacement` note asks for).
- Each utterance is transcribed by `SFSpeechRecognizer` with `requiresOnDeviceRecognition=true`
  (no network; ANE/CPU on-device path). Latency is wall-clock from request submit to final result.
- WER uses the same normalize + Levenshtein word-edit metric as `native/verify/asr_bench.ts`.
- Audio is checked in under `audio/` so the measurement is listenable and reproducible.

## Per-platform Stage-B recommendation (VOICE_UX.md §7)

- **iOS / Apple Silicon:** the measured on-device `SFSpeechRecognizer` arm confirms the §7 claim —
  real-time-factor < 1 (faster than real time) and exact accept on clean speech — so the
  ANE-capable `SFSpeechRecognizer` is the cheapest-correct Stage-B confirm recognizer on Apple.
  Kokoro TTS is unchanged. iOS device energy telemetry is not counted as covered by this
  Apple-Silicon-only artifact; it must be supplied through the strict Stage-B report gate.
- **Android:** `SpeechRecognizer` (NNAPI) latency/battery/accept is not counted as covered by
  this host artifact; it must be supplied through the strict Stage-B report gate.
- **Linux/desktop fused:** the fused libelizainference ASR latency/RTF on the identical corpus is a
  required report input when the provisioned `libelizainference` bundle is available.
  Historical qualitative ASR artifacts are not accepted as Stage-B coverage; use
  `ELIZA_VOICE_STAGE_B_REPORT` with `packages/scripts/voice-stage-b-eval.mjs`.

## Strict report gate (not measured by this Apple-only host artifact)

The complete #9958 Stage-B decision is green only when `voice-stage-b-eval.mjs`
validates a reviewed JSON report covering iOS `SFSpeechRecognizer`, Android
`SpeechRecognizer`, and fused ASR with real hardware, latency, WER, and power telemetry.

## Required external measurements

| Arm | Needs | Run |
|---|---|---|
| iOS battery/energy per frame | real iOS device + Instruments | Xcode Instruments Energy Log over a Stage-B confirm session |
| Android `SpeechRecognizer` (NNAPI) | real Android device | port `stage-b-stt-bench` to an instrumented Android test using `SpeechRecognizer` |
| Fused ASR on identical corpus | provisioned `libelizainference` bundle | `bun plugins/plugin-local-inference/native/verify/asr_bench.ts --wav-dir <this audio/> --real-recorded` |
