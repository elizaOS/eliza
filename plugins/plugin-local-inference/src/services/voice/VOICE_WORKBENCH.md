# Voice Workbench

Tracking issue: [elizaOS/eliza#8785](https://github.com/elizaOS/eliza/issues/8785).

elizaOS ships a mature voice pipeline (VAD, streaming ASR, EOT classifier,
barge-in, diarization, speaker imprint/profiles, Kokoro/OmniVoice TTS) but its
test harnesses were **fragmented** across five families with no shared scenario
format, no shared corpus, divergent metric definitions, and a headful surface
that only covered a single-speaker, single-turn round-trip. The Voice Workbench
unifies them onto **one scenario format, one metric module, and one report**.

## Status

This directory holds the **pure, framework-level foundation** — the parts that
can be implemented, tested, and shipped without an audio corpus, native models,
or a browser. The execution runners that actually drive real services/audio are
intentionally **gated** (they need a provisioned Eliza-1 local backend + a
synthesized corpus) and are listed under *Remaining* below.

### Implemented (this directory, unit-tested, no native artifacts)

| Piece | File | What it is |
| --- | --- | --- |
| **Scenario schema** | `voice-scenario.ts` | The declarative `VoiceScenario` format: named `participants` (voice→entity), ordered `turns` (`expectRespond`, `expectedTranscript`, `expectedSpeakerLabel`, `expectedEntity`, `pausesMs`), scenario `assertions` (WER/DER/EOT/latency ceilings), and `classes`. Pure `validateVoiceScenario` reports every consistency error at once. |
| **Metric module (single source of truth)** | `e2e-harness.ts` | All voice scoring lives here. WER is delegated to `@elizaos/shared/voice-wer` (one definition for headless + headful). Added scorers: `scoreEotDecision` (latency p50/p95 + false-trigger/false-suppression rate), `scoreRespondDecision` (FP/FN split), `scoreDiarization` (DER + confusions/misses), `scoreEntityExtraction` (precision/recall/F1), `scoreVoiceEntityMatch` (recognized-voice→entity accuracy). |
| **Benchmark report** | `voice-workbench-report.ts` | `buildVoiceWorkbenchReport` rolls a matrix of per-scenario scorer results into one gating report (per-metric mean/worst + percentiles, per-scenario verdict). `formatVoiceWorkbenchMarkdown` renders it; `regressionsAgainstBaseline` flags metrics that worsened past a tolerance. |
| **WER consolidation** | `@elizaos/shared/voice-wer` | The previously-duplicated `wordErrorRate` (`e2e-harness.ts` **and** `voice-selftest-harness.ts`, with subtly different normalization) is now defined once — Unicode-aware, contraction-preserving — and imported by both. |

Tests: `voice-workbench.test.ts`, `voice-workbench-report.test.ts`,
`e2e-harness.test.ts`.

### Honesty contract

A scenario whose corpus/backend artifacts are absent is reported `skipped`,
**never `pass`** — matching the existing self-test contract. A workbench report
is `skipped` overall only when *every* scenario was skipped; one ran-and-failed
scenario makes the whole report `fail`.

## Execution modes (the three the schema feeds)

1. **Headless** — feed corpus audio through the real services without a browser:
   `/api/asr/local-inference`, `LiveDiarizationSession` / `/api/voice/audio-frames`,
   the `ELIZA_VOICE_EOT_BACKEND` classifier, respond/room decisions over a real
   `AgentRuntime` (scenario-runner PGLite boot), `VOICE_TURN_OBSERVED` /
   `VOICE_ENTITY_BOUND` / `IDENTIFY_SPEAKER`, and `/api/tts/local-inference`.
2. **Headful** — extend `VoiceSelfTestShell` (`packages/ui/src/voice/voice-selftest/`)
   from a single-turn self-test into a scenario player that drives the real
   client pipeline (capture → ASR → SSE → TTS → playback) turn-by-turn, with
   per-turn machine-readable + DOM-mirrored verdicts.
3. **Benchmark/report** — a single `voice:workbench` entrypoint that runs the
   matrix in both modes and rolls up via `voice-workbench-report.ts` into one
   JSON + Markdown report with regression baselines.

All three consume the **same** `VoiceScenario` and the **same** scorers, so a
metric is defined exactly once regardless of where the audio is driven.

## Consolidation map (what converges here)

The workbench is the convergence point for these previously-disjoint harnesses:

| Legacy harness | Convergence |
| --- | --- |
| `e2e-harness.ts:wordErrorRate` + `voice-selftest-harness.ts:wordErrorRate` | **Done** — one `@elizaos/shared/voice-wer`. |
| Pure scoring lib (`e2e-harness.ts`) | **Promoted** to the single metric module (EOT/diarization/respond/entity scorers added). |
| `packages/app-core/scripts/voice-duet.mjs` (`voice:duet`), `voice-e2e-hardware.ts`, `voice-vad-smoke.ts`, `voice-attribution-smoke.ts`, `lib/duet-bridge.mjs` | Feed measurements into the shared scorers + report (planned absorb). |
| `packages/benchmarks/voice/three-voice-scenario.mjs`, `three-voice-e2e-real.mjs` | Corpus-generation precedent the `VoiceScenario` corpus generator extends (planned). |
| `packages/benchmarks/voicebench/` (TS latency p95/p99) | The report layer mirrors its p95/p99 shape; remains a research bench linked from the workbench. |
| Per-spec inline `tinyWav()` fixtures (`packages/app/test/ui-smoke/voice-*.spec.ts`) | Replaced by the versioned corpus (planned). |

## Remaining (gated — needs corpus + real backend)

These are tracked on #8785 and are **not** stubbed here (no LARP):

- **Corpus generator + versioned labeled corpus** — TTS-synthesize each turn,
  splice pauses, mix multi-speaker streams; persist labeled WAV + ground-truth
  JSON. Needs the real TTS routes / Kokoro voices. (`__test-helpers__/synthetic-speech.ts`
  is the synthesis seed.)
- **Headless runner** — wire the scenario through the real ASR/diarization/EOT/
  respond/entity/TTS services + `AgentRuntime`.
- **scenario-runner audio turn kind** — add an `audio`/`voice` `ScenarioTurnExecution`
  so voice scenarios become first-class `.scenario.ts` files.
- **Headful scenario player** — `VoiceSelfTestShell` → multi-turn player +
  `packages/app/test/ui-smoke/voice-workbench-*.spec.ts` per scenario class.
- **`voice:workbench` entrypoint + CI lane** — run the matrix, emit the report
  (`buildVoiceWorkbenchReport`), `skipped` (never `pass`) when artifacts absent.
- **Multi-agent room semantics** — the canonical ≥3-participant "who responds"
  contract (an open question on the issue) must be settled before the workbench
  can assert against it rather than inventing a rule.
