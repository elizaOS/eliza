# Voice Workbench

Tracking issue: [elizaOS/eliza#8785](https://github.com/elizaOS/eliza/issues/8785).

elizaOS ships a mature voice pipeline (VAD, streaming ASR, EOT classifier,
barge-in, diarization, speaker imprint/profiles, Kokoro/OmniVoice TTS) but its
test harnesses were **fragmented** across five families with no shared scenario
format, no shared corpus, divergent metric definitions, and a headful surface
that only covered a single-speaker, single-turn round-trip. The Voice Workbench
unifies them onto **one scenario format, one metric module, and one report**.

> **Capability assessment + evidence map** (what is CI-proven vs hardware/
> credential-gated, mapped to every #8785 AC and the product-owner questions):
> [research/VOICE_8785_ASSESSMENT.md](./research/VOICE_8785_ASSESSMENT.md).
> Research evidence base (pause lengths, VAD, AEC, diarization, owner verification,
> model landscape, latency math): [research/VOICE_PIPELINE_RESEARCH_2026.md](./research/VOICE_PIPELINE_RESEARCH_2026.md).

## Status

The schema, corpus generator (incl. acoustic degradation), metric module,
headless runner, report, scenario-runner `voice` turn kind, headful scenario
player, and the `voice:workbench` CLI are all **implemented and unit-tested**.
The only intentionally **gated** piece is the real **acoustic-model** lane
(`--real`): driving the corpus through Qwen3-ASR / WeSpeaker / pyannote / Silero
/ Kokoro needs the native fused lib + GGUF bundles, so it reports `skipped`
(never `pass`) when those artifacts are absent.

### Execution lanes (`voice:workbench`)

| Lane | Services | Proves | CI |
| --- | --- | --- | --- |
| `--mock` (default) | `groundTruthMockServices` echoes ground truth | runner → scorers → report wiring | ✅ always |
| `--logic` | `realDecisionLogicServices` runs the SHIPPED EOT + respond/echo/bystander/wake-word gate + name extraction + owner inference | the **decision logic** (catches a regression the moment it lands) | ✅ always (no models) |
| `--real` | real acoustic backend | real WER/DER/EOT-latency, acoustic speaker verification | 🟡 gated → `skipped` |

The `--logic` lane is the key anti-hollow guarantee: it does NOT echo the corpus,
it runs the same gate the UI client ships (`@elizaos/shared/voice/respond-gate`),
so the workbench genuinely suppresses a bystander, rejects the agent's echoed
reply, and holds on a mid-utterance pause — asserted by tests, not assumed.

### Implemented (this directory, unit-tested, no native artifacts)

| Piece | File | What it is |
| --- | --- | --- |
| **Scenario schema** | `voice-scenario.ts` | The declarative `VoiceScenario` format: named `participants` (voice→entity), ordered `turns` (`expectRespond`, `expectedTranscript`, `expectedSpeakerLabel`, `expectedEntity`, `pausesMs`), scenario `assertions` (WER/DER/EOT/latency ceilings), and `classes`. Pure `validateVoiceScenario` reports every consistency error at once. |
| **Metric module (single source of truth)** | `e2e-harness.ts` | All voice scoring lives here. WER is delegated to `@elizaos/shared/voice-wer` (one definition for headless + headful). Added scorers: `scoreEotDecision` (latency p50/p95 + false-trigger/false-suppression rate), `scoreRespondDecision` (FP/FN split), `scoreDiarization` (DER + confusions/misses), `scoreEntityExtraction` (precision/recall/F1), `scoreVoiceEntityMatch` (recognized-voice→entity accuracy). |
| **Benchmark report** | `voice-workbench-report.ts` | `buildVoiceWorkbenchReport` rolls a matrix of per-scenario scorer results into one gating report (per-metric mean/worst + percentiles, per-scenario verdict). `formatVoiceWorkbenchMarkdown` renders it; `regressionsAgainstBaseline` flags metrics that worsened past a tolerance. |
| **WER consolidation** | `@elizaos/shared/voice-wer` | The previously-duplicated `wordErrorRate` (`e2e-harness.ts` **and** `voice-selftest-harness.ts`, with subtly different normalization) is now defined once — Unicode-aware, contraction-preserving — and imported by both. |
| **Acoustic robustness corpus** | `corpus-augment.ts` | Seeded, deterministic degradation DSP: additive room noise (white/pink at a target SNR), Freeverb reverb, far-field attenuation, telephone/low-quality line (band-limit + µ-law), and competing background talkers. Wired into the corpus generator via a per-turn / per-scenario `environment` so a clean scenario and a noisy one share one schema. |
| **Real-decision-logic adapter** | `workbench-logic-services.ts` | Runs the SHIPPED EOT + respond/echo/bystander/wake-word gate + name extraction over the corpus (no models). The `--logic` lane. |
| **Respond/echo gate (single source)** | `@elizaos/shared/voice/respond-gate` | `shouldRespondToVoiceTurn` + `buildVoiceTurnSignal`, promoted out of the UI so the client and the workbench share one definition. The UI re-exports it. |
| **Owner inference** | `@elizaos/shared/voice/owner-inference` | `resolveOwnerCandidate` — proposes the owner from who speaks most/most-confidently, only when sufficient AND unambiguous, else UNDECIDED. The logic an owner-detection provider/evaluator runs when no owner is enrolled. |
| **Echo + owner scorers** | `e2e-harness.ts` | `scoreEchoRejection` (agent-echo turns correctly suppressed) and `scoreOwnerSecurity` (owner-vs-intruder accuracy + impostor-accept rate). |

Tests: `voice-workbench.test.ts`, `voice-workbench-report.test.ts`,
`e2e-harness.test.ts`, `corpus-augment.test.ts`,
`workbench-logic-services.test.ts`, `corpus-generator.test.ts`, and (in shared)
`voice/owner-inference.test.ts`.

### Scenario classes

`multi-voice`, `pauses`, `respond-no-respond`, `multi-speaker`, `diarization`,
`entity-extraction`, `voice-recognition`, `eot`, `transcription-mode`,
`multi-agent-room`, `long-form-monologue`, **`robustness`** (noise / reverb /
far-field / low-quality), **`echo-rejection`** (agent self-voice), **`owner-security`**
(owner vs intruder), **`overlapping-speech`** (interrupting talkers). The 12
built-in scenarios in `workbench-scenarios.ts` span every class.

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

## Remaining (gated — needs real acoustic models / live cloud / device)

Not stubbed here (no LARP); each reports `skipped`, never `pass`, until the
artifact is present. Full detail + why in
[research/VOICE_8785_ASSESSMENT.md §5](./research/VOICE_8785_ASSESSMENT.md).

- **`--real` acoustic lane** — drive the corpus through the real Qwen3-ASR /
  WeSpeaker / pyannote / Silero / openWakeWord / Kokoro models to measure real
  WER/DER/EOT-latency and acoustic speaker verification. Needs the native fused
  lib + GGUF bundles (model loading EMFILEs under the repo's `coverage=true`
  bunfig — run real smokes OUTSIDE `bun test`).
- **Live cloud STT/TTS round-trip** — ElevenLabs via `/api/v1/voice/*`; needs an
  authenticated Cloud session (the test account returns HTTP 402 — a billing
  state, not a code bug).
- **Headful real-backend + recorded A/V** — the 10 `voice-workbench-*.spec.ts`
  run with mocked backends; a real-backend headful lane with audio+video capture
  needs a provisioned local backend on the CI host.
- **iOS device** — blocked on Apple ID provisioning; simulator local-inference is
  Metal-limited.

## Open follow-up: PCM-level acoustic echo cancellation

Self-echo is caught at the transcript level only (word overlap). The recommended
next step is an `agentSpeaking` flag + ~1.5 s post-TTS cooldown (cheap, robust),
then WebRTC AEC3 with a time-aligned reference, then speaker-embedding self-voice
rejection. The `scoreEchoRejection` scorer is ready to gate it. See
[research/VOICE_8785_ASSESSMENT.md §6](./research/VOICE_8785_ASSESSMENT.md).
