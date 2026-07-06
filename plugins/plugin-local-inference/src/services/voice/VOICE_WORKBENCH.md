# Voice Workbench

Tracking issue: [elizaOS/eliza#8785](https://github.com/elizaOS/eliza/issues/8785).

elizaOS ships a mature voice pipeline (VAD, streaming ASR, EOT classifier,
barge-in, diarization, speaker imprint/profiles, Kokoro TTS) but its
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
The real **acoustic-model** lane (`--real`) is implemented as a provisioned
hardware lane: it generates distinct human voices with ElevenLabs, synthesizes
agent echoes with the fused local TTS, and scores the corpus through fused ASR,
WeSpeaker, pyannote, and the shipped respond/self-voice gate. Missing real
artifacts are a hard failure in `--real`, not all-skipped evidence.

### Execution lanes (`voice:workbench`)

| Lane | Services | Proves | CI |
| --- | --- | --- | --- |
| `--mock` (default) | `groundTruthMockServices` echoes ground truth | runner → scorers → report wiring | ✅ always |
| `--logic` | `realDecisionLogicServices` runs the SHIPPED EOT + respond/echo/bystander/wake-word gate + name extraction + owner inference | the **decision logic** (catches a regression the moment it lands) | ✅ always (no models) |
| `--real` | ElevenLabs human speech + fused local TTS/ASR + WeSpeaker + pyannote | real WER/DER/EOT/respond/self-voice/owner-security measurements | ✅ provisioned nightly/hardware lane |

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
| **Meeting acoustic stress matrix** | `meeting-acoustic-stress-matrix.ts` | `buildMeetingAcousticStressMatrix()` emits deterministic workbench scenarios plus source-manifest metadata for #12492: SNRs -5/0/5/10/20 dB, music/noise/babble/TV/outdoor backgrounds, close/far/reverb/room-mic rooms, clipping/telephone/compression/dropout quality artifacts, speech-structure stressors, 1/2/3/5/8-speaker single-stream cases, and negative expectations (`unknown`, `do_not_respond`, `needs_speaker_correction`). Generate WAVs + ground truth with `bun run scripts/generate-voice-corpus.ts --meeting-stress --out <dir>`. |
| **Real-decision-logic adapter** | `workbench-logic-services.ts` | Runs the SHIPPED EOT + respond/echo/bystander/wake-word gate + name extraction over the corpus (no models). The `--logic` lane. |
| **Real acoustic adapter** | `workbench-real-services.ts` | The `--real` lane: ElevenLabs-generated human speech, fused local agent TTS, fused ASR, WeSpeaker speaker centroids, pyannote speech/overlap labels, live `selfVoiceSimilarity`, owner inference, and the same respond gate. |
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
(owner vs intruder), **`overlapping-speech`** (interrupting talkers),
**`name-disambiguation`** (similar-sounding names — Jon/John/Joan, Erik/Erika,
Mia/Maya — each bind to exactly their own entity under clean, noisy, and
garbled-transcript conditions; `minEntityF1` pins the extraction gate to 1).

The sibling-behavior classes (#12258) each pin a settled ceiling:

- **`endpoint-latency`** — a clean, sentence-final command commits at the
  endpoint; `maxFirstAudioMs: 800` on the real lane (#12254).
- **`tail-off`** — a filler, dangling-modal, or trailing-conjunction pause must
  NOT commit (`maxEotFalseTriggerRate`); the fused semantic-EOT gate holds
  (#12255 / #12889).
- **`streaming-partials`** — a streaming-ASR partial stream's committed prefix
  never retracts (`scorePartialMonotonicity`); scored only where a partial feed
  exists, skipped honestly in batch-only lanes (#12254).
- **`speaker-gated-barge-in`** — a wake-word interjection hard-stops the TTS
  within `maxBargeInCancelMs: 250`; the agent's own echo and an unenrolled
  bystander must NOT cancel (`scoreBargeInGating`; #12255).
- **`desktop-aec`** — the desktop speak-back echo is scored for `minErleDb: 18`
  AND self-voice rejection; ERLE consumes the echo sub-issue's AEC/ERLE
  telemetry and is skipped honestly where absent (#12256).
- **`long-turn-diarization`** — a ~30 s three-voice exchange, windowed
  incrementally, within the AMI meeting DER budget (#12257).

The 26 built-in scenarios in `workbench-scenarios.ts` span every class.

### Assertion ceilings (parent decision #10)

Ceilings live in each scenario's `assertions` (per lane), not in the scorer
defaults (the scorer's permissive default stands only when a scenario declares
nothing). `regressionsAgainstBaseline` gates the deterministic `--logic` lane at
a flat 0.02 tolerance — every metric there is constant, so the tolerance is a
"must stay byte-stable" gate; the `--real` lane's ms/dB metrics are reviewed
against these ceilings by hand, not this gate.

| Ceiling | Value | Where asserted |
| --- | --- | --- |
| Time-to-first-audio (real lane) | `maxFirstAudioMs` **800 ms** | `endpoint-latency`, `multi-voice-greeting`, `respond-vs-bystander` |
| Barge-in cancel (legit interjection) | `maxBargeInCancelMs` **250 ms** | `speaker-gated-barge-in` |
| Speaker-gating (echo / bystander) | must NOT cancel (`scoreBargeInGating`) | `speaker-gated-barge-in` |
| DER — clean / 2–3 speaker | `maxDer` **0.213** (VoxConverse 11.3% + 10 pp) | `multi-voice-greeting`, `multi-speaker-name-capture`, `confusable-names-*` |
| DER — noisy / overlap / long-turn | `maxDer` **0.288** (AMI 18.8% + 10 pp) | `noisy-room-commands`, `music-background-commands`, `confusable-names-noisy`, `long-turn-diarization` |
| Echo rejection | `minEchoRejectionRate` **1** | `echo-*`, `desktop-aec-echo`, `speaker-gated-barge-in` |
| ERLE (AEC scenarios) | `minErleDb` **18 dB** | `desktop-aec-echo` |
| EOT false-trigger / tail-off | `maxEotFalseTriggerRate` | `endpoint-latency` (0), `tail-off-thinking` (0), `pauses-midutterance` |

### Honesty contract

A scenario whose corpus/backend artifacts are absent is reported `skipped`,
**never `pass`** — matching the existing self-test contract. A workbench report
is `skipped` overall only when *every* scenario was skipped; one ran-and-failed
scenario makes the whole report `fail`. `voice:workbench --real` is the one
exception to "skip": it **hard-fails** on any missing acoustic artifact (a clear
`missing …` error, exit 1) — an all-skipped `--real` run would be dishonest
"skip-as-evidence", so a provisioned lane must produce numbers or fail loud.

## Evidence bundle every voice PR files (#12258)

The workbench is the single verification surface (parent decision #10), so every
voice PR — loud-fail (#12253), latency (#12254), turn-taking (#12255), echo
(#12256), diarization (#12257) — files a **before/after** bundle under
`.github/issue-evidence/<issue#>-*/`, citing ceilings from the table above:

1. **Workbench reports (before + after)** — `voice:workbench --logic --baseline
   src/services/voice/__fixtures__/voice-workbench-logic-baseline.json` (JSON +
   MD). A sibling that tightens behavior refreshes the baseline in the SAME PR
   and shows the metric moving in the right direction; a regression reds the
   gate. The `--mock` report proves the wiring path end-to-end.
2. **Latency tables (before + after)** — `node
   packages/app-core/scripts/voice-latency-report.mjs --json` (or `bun run
   voice:latency-report`) against a running app, per-stage p50/p90/p99; required
   for any latency-touching change and cited against `maxFirstAudioMs`.
3. **interrupt-bench numbers** — `bun run --cwd
   packages/benchmarks/interrupt-bench test` for barge-in / interruption changes.
4. **Captured real audio + narrated walkthrough** — `AGENTS.md` is binding
   for voice: the real STT→TTS round-trip audio, backend `[ClassName]` logs
   showing the exact path (router re-throw, AEC `echoReferenceWired` flip,
   barge-in hard-stop), per-platform capture for native/desktop changes.
5. **Domain artifacts, hand-reviewed** — voice profiles on disk, `/api/dev/
   voice-latency` traces, ERLE captures, the workbench JSON+MD — opened and read,
   not just captured.

The real acoustic lane (`--real`) needs `ELEVENLABS_API_KEY` + a fused bundle
(`ELIZA_ASR_BUNDLE`) + speaker/diarizer GGUFs; absent them it hard-fails (never a
false pass). This issue dogfoods the bundle in its own PR.

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

The metric module is the single source of scorer math: every new gate added for
#12258 (`scoreBargeInGating`, `scoreErle`, `scorePartialMonotonicity`) lives in
`e2e-harness.ts`, so the report + baseline + all lanes share one definition and
no scorer math is duplicated in the new work.

| Legacy harness | Convergence |
| --- | --- |
| `e2e-harness.ts:wordErrorRate` + `voice-selftest-harness.ts:wordErrorRate` | **Done** — one `@elizaos/shared/voice-wer`. |
| Pure scoring lib (`e2e-harness.ts`) | **Promoted** to the single metric module (EOT/diarization/respond/entity + barge-in-gating/ERLE/partial scorers). |
| `packages/benchmarks/interrupt-bench` (barge-in / interruption scoring) | **Wired into CI** — runs in the `voice-workbench.yml` PR lane alongside the `--logic` regression gate. |
| `packages/app-core/scripts/voice-duet.mjs` (`voice:duet`), `voice-e2e-hardware.ts`, `voice-attribution-smoke.ts`, `lib/duet-bridge.mjs` | **Planned** — route their measurements through the shared scorers + emit the schema-v1 report. Deferred (not merge-first per #12258): each is a 650–1355-line provisioned-hardware script consumed on its own CLI path; absorbing it means porting live measurements onto the observation shape without breaking the hardware lane. No new scorer math has been added inside them. |
| `packages/benchmarks/voice/three-voice-scenario.mjs` | **Planned** — its synthetic-label DER precedent (its inline DER is trivially 0 on exact synthetic labels) is superseded by the corpus generator + `computeDiarizationErrorRate`; folding the `.mjs` corpus path in is deferred with the scripts above. |
| `packages/benchmarks/voicebench/` (TS latency p95/p99) | The report layer mirrors its p95/p99 shape; remains a research bench linked from the workbench. |
| Per-spec inline `tinyWav()` fixtures (`packages/app/test/ui-smoke/voice-*.spec.ts`) | **Planned** — replace with the versioned corpus; deferred (owned by the app UI-smoke lane, not the workbench-merge-first set). |

## External / Device Follow-Ups

Full detail + why in
[research/VOICE_8785_ASSESSMENT.md §5](./research/VOICE_8785_ASSESSMENT.md).

- **Live cloud STT/TTS round-trip** — ElevenLabs via `/api/v1/voice/*`; needs an
  authenticated Cloud session (the test account returns HTTP 402 — a billing
  state, not a code bug).
- **PCM-level AEC** — still a product/runtime feature beyond the workbench
  scorer: it needs a time-aligned playback reference and cancellation path in
  the live audio transport, then the workbench can score the resulting echo
  corpus.
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
