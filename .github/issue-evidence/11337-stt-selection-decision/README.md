# #11337 — STT WER+latency benchmark + documented per-device selection decision

Close-out record. The benchmark harness and the measured numbers landed in
merged PRs; this slice ships the **documented decision** the issue demanded and
verifies the heuristic against the measured winners.

## What already existed (merged)

- **Benchmark harness over a labelled corpus, with noise variants** — PR #11388:
  `plugins/plugin-local-inference/scripts/stt-quant-bench-real.ts`
  (`sttquant:real`) + `noise-rejection-real.ts` (`noise:real`). Real eliza-1-asr
  weights via the fused lib, real Kokoro-synthesized labelled corpus, fail-closed
  gates. Evidence: `.github/issue-evidence/10726-noise-stt-suites-2026-07-02/`.
- **Measured numbers** (Linux x86-64, CPU-only):
  - eliza-1-asr bundle-2b: **WER 0.008 mean / 0.000 median, RTF 0.262 (3.8× realtime)**, load 1.85 s.
  - Noise matrix (WER vs SNR over white/pink/music/babble at 20…−5 dB): clean 0.008; ≤ 0.04 at 10 dB except babble 0.039; collapses only below 0 dB babble.
  - Real recorded speech (`freeman.wav`): accurate transcription, 13.1 s/clip (`test:asr:real`, `10726-host-voice-lanes-linux-2026-07-02.md`).
- **Apple `SFSpeechRecognizer` measured on-device** (darwin arm64): quiet WER 0.0 % / RTF 0.168 / 243 ms mean; 10 dB noise WER 4.0 % / RTF 0.245 (`.github/issue-evidence/9958-stt-stage-b-eval/`).
- **Android fused-ASR bring-up** (physical Pixel 6a): WER 0 on the self-test utterance; 31.3 s asr stage including model load — bring-up proof, not an interactive-latency benchmark (`.github/issue-evidence/10726-android-voice-selftest/`).
- **Measurable quality improvement recorded** — TTS WER 1.00 → 0.13 (PR #11238) and the 0.008-WER STT baseline with pass gates (PR #11388).

## What this slice adds

1. **`packages/ui/src/voice/STT_SELECTION.md`** — the committed per-device
   selection decision: candidate backends, every measured number above with
   evidence links, the decision + rationale per platform×runtime, honest
   needs-hardware rows for Android `SpeechRecognizer` / iOS energy / fused
   on-device steady-state, and the Stage-B path
   (`eliza_voice_stage_b_stt_eval_v1`, `voice-stage-b-eval.mjs`,
   `VOICE_LIVE_MATRIX.md`) by which those rows get measured when hardware is
   provisioned (#10727 / `voice-live-e2e.yml`).
2. **`pickDefaultVoiceProvider` verified against the measured winners** — they
   match: fused local ASR wins on desktop where provisioned (WER 0.008, 3.8×
   realtime; heuristic already picks `local-inference`); no committed
   measurement justifies flipping mobile/web away from `eliza-cloud` (the only
   on-device number is 31.3 s including load on Pixel 6a). **No code change to
   the heuristic**; its doc-comment now cites `STT_SELECTION.md` so the choice
   is evidence-linked, not folklore.
3. **Extra-candidate benchmarking documented** — `stt-quant-bench-real.ts`
   already accepts arbitrary candidate GGUFs (`ELIZA_ASR_QUANT_DIR` +
   `ELIZA_ASR_BUNDLE`); `STT_SELECTION.md` documents the knobs and the update
   rule when a new row wins.
4. **Restored evidence deleted by accident** —
   `10726-host-voice-lanes-linux-2026-07-02.md` and the two Kokoro
   before/after WAVs were added by PR #11238 but removed by the unrelated cloud
   refund refactor commit `5b714c74e6` (fleet collision). Restored verbatim
   from `3c17470d56` since the decision doc cites them.

## Honest residue (needs hardware; tracked, not hidden)

Per-engine measured rows still missing, all device-gated (coordinate #10727 +
`voice-live-e2e.yml`; Stage-B strict gate defined in `VOICE_LIVE_MATRIX.md`):

- Android `SpeechRecognizer` (NNAPI) WER/latency/battery on a real device.
- iOS `SFSpeechRecognizer` battery/energy telemetry (Instruments).
- Fused ASR steady-state RTF/battery on-device (`asr_bench.ts --real-recorded`).

These are exactly the `stt.stage-b.evaluation` inputs; the decision table says
what would flip (mobile default) if they land favorable numbers.
