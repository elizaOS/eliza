# Evidence — #12258 Voice workbench: TTFA/barge-in/echo/DER gates + CI

This issue establishes the **before/after harness** the sibling voice PRs
(#12254–#12257) cite. "Before" numbers are the reference the siblings move; this
PR's own gates pass green on `develop`.

## Assertion ceilings (parent decision #10) — with before-numbers

Ceilings live in each scenario's `assertions` (per lane). Before-numbers are from
the **`--logic` lane** (real shipped decision logic, no models) captured on this
branch — the deterministic reference the regression gate protects.

| Ceiling | Value | Before (logic lane) | Scenario(s) |
| --- | --- | --- | --- |
| Time-to-first-audio (real lane) | `maxFirstAudioMs` 800 ms | 250 ms (fixed sub-budget in model-free lane) | endpoint-latency, multi-voice-greeting, respond-vs-bystander |
| Barge-in cancel (legit interjection) | `maxBargeInCancelMs` 250 ms | 120 ms | speaker-gated-barge-in |
| Speaker-gating (echo/bystander must hold) | gating accuracy 1.0 | 1.0 (echo + bystander held, wake-word cancelled) | speaker-gated-barge-in |
| DER — clean / 2–3 speaker | `maxDer` 0.213 (VoxConverse 11.3% + 10 pp) | worst 0.0 clean | multi-voice-greeting, multi-speaker-name-capture, confusable-names-* |
| DER — noisy / overlap / long-turn | `maxDer` 0.288 (AMI 18.8% + 10 pp) | worst 0.2394 (confusable-names-noisy) | noisy/music/confusable-names-noisy, long-turn-diarization |
| Echo rejection | `minEchoRejectionRate` 1 | 1.0 | echo-*, desktop-aec-echo, speaker-gated-barge-in |
| ERLE (AEC scenarios) | `minErleDb` 18 dB | unscored in logic lane (no AEC feed — honest skip); 24 dB in mock plumbing lane | desktop-aec-echo |
| EOT false-trigger / tail-off | `maxEotFalseTriggerRate` | 0.0 (tail-off held, endpoint committed) | endpoint-latency, tail-off-thinking, pauses-midutterance |

Full metric rollup: [`workbench-logic-report.md`](./workbench-logic-report.md) /
[`.json`](./workbench-logic-report.json). Overall: **PASS — 24 ran, 0 skipped**.

## New scenario classes (6, one per sibling deliverable)

`endpoint-latency` (#12254), `tail-off` (#12255), `streaming-partials` (#12254),
`speaker-gated-barge-in` (#12255), `desktop-aec` (#12256),
`long-turn-diarization` (#12257). Each runs in `--logic` (decision logic) and
`--real` (models) as applicable and **skips honestly** where its service is
absent — ERLE and partial-monotonicity are unscored in the model-free logic lane
(no AEC / no streaming ASR), and the mock plumbing lane exercises the full wiring
(ERLE 24 dB, partial retractions 0, barge-in gating 1.0) — see
[`workbench-mock-report.md`](./workbench-mock-report.md).

## Honesty contract — `--real` never false-passes

[`real-lane-hardfail.txt`](./real-lane-hardfail.txt): `voice:workbench --real`
without provisioned artifacts exits **1** with a clear `missing …` error and
writes **no report** — never a false `pass` or an all-skipped honesty stub. The
nightly CI `--real` job (`voice-workbench.yml`) guards on provisioned
secrets/paths and skips honestly on the shared runner.

## Verification (all green on `develop`)

- `bun run --cwd plugins/plugin-local-inference voice:workbench -- --logic --baseline src/services/voice/__fixtures__/voice-workbench-logic-baseline.json` → **PASS, no regressions** (24 scenarios).
- `bun run --cwd plugins/plugin-local-inference voice:workbench` (mock plumbing) → **PASS, 24 ran**.
- `bun run --cwd plugins/plugin-local-inference voice:workbench -- --real` (no artifacts) → **exit 1, no false pass**.
- Touched vitest suites (e2e-harness / headless-runner / report / workbench / logic-services / entrypoint / scenario / fuzz / corpus): **82 passed**.
- `typecheck` (tsgo) + Biome `check`: **clean**.
- [`interrupt-bench.txt`](./interrupt-bench.txt) — `packages/benchmarks/interrupt-bench` barge-in/interruption suite: **237 tests passed**.
- `voice-latency-report.mjs --json`: **N/A** — no running app in this harness lane; the tool works (returns structured JSON, see [`latency-report-before.json`](./latency-report-before.json)); it is the siblings' live-app latency evidence (#12254).

## Real-LLM trajectory

**N/A** — this is a deterministic test/benchmark harness (schema, scorers,
scenarios, CI). No agent/action/provider/prompt/model behavior changes; the
`--logic` lane runs the SHIPPED decision logic with no LLM. The `--real` acoustic
lane (ElevenLabs + fused local ASR/TTS/WeSpeaker/pyannote) is the model-driven
surface siblings run on provisioned hardware.
