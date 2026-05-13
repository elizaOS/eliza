# Eliza-1 Native DFlash Accept/Reject Events

The local-inference runtime previously synthesized "accept" verifier events
from each SSE text chunk on the JS side. That gave the voice loop a usable
token cursor but threw away the data the autotuner actually needs:

- The true ratio of drafter-proposed tokens to verifier-accepted tokens.
- The exact target-side indices the verifier rejected in a rollback.
- Round boundaries — how many speculation rounds happened, and how each one
  performed.

This document describes the native event protocol that closes those gaps and
the rollout plan. The C-side llama-server emission is pending the next merge
of the `buun-llama-cpp` fork; the JS-side parsing, accumulator, and stats
plumbing have landed behind a feature flag so they're ready the moment the
fork lands.

## Why this matters

- **Correct rollback** — the legacy `verifier.rejected` chunk shape supports
  retraction but never fires upstream; today every "reject" the JS sees is a
  fake derived from text. The native protocol emits real
  `{ rejectRange, correctedToken }` events so the phrase chunker can drop
  the exact spoken audio that needs to be retracted.
- **Autotune feedback** — `dflashStats` on the `generateWithUsage` result
  reports exact `drafted / accepted / rounds / acceptanceRate` per turn.
  `DflashTurnHistory` keeps a rolling window of recent turns and exposes
  p50 / p95 acceptance quantiles so the autotuner can grow / shrink
  `draftMax` from real data, not a `/metrics` diff.
- **Bench harness** — voice-bench can read native events through
  `DflashTurnHistory.addListener` and write them next to other latency
  traces without polling Prometheus counters.

## Protocol

Specified in [`dflash-native-events-protocol.md`](./dflash-native-events-protocol.md).
TL;DR:

- `GET /health` advertises support via `capabilities.dflashNativeEvents`.
- Each `POST /v1/chat/completions` SSE chunk MAY carry a top-level `dflash`
  field (single event or array of events) alongside the standard `choices`
  delta.
- Event kinds: `accept`, `reject`, `speculate-start`, `speculate-end`.
- The protocol is additive — old clients ignore the field, old servers omit it.

## Feature flag

The runtime consumes native events only when BOTH switches are true:

1. **Per-bundle opt-in** —
   `runtime.optimizations.nativeDflashEvents` on the catalog model
   (`packages/shared/src/local-inference/types.ts` →
   `LocalRuntimeOptimizations.nativeDflashEvents`). Defaults to false; the
   bundle author flips it on once the bundle's drafter / verifier pair has
   been verified against the C-side emitter.
2. **Runtime capability probe** —
   `DflashLlamaServer.probeNativeDflashEventsCapability()` calls `/health`
   once per spawned-server lifetime and checks
   `capabilities.dflashNativeEvents === true`. The probe is cached; a
   missing capability forces the legacy synthesis path on every subsequent
   call until the server is restarted.

If either switch is false, the synthesized accept-only stream runs
unchanged and `result.dflashStats` is `undefined`.

## How to verify a turn used native events

`generateWithUsage` returns `dflashStats` only when both flags above hold
AND at least one native `accept` event arrived on the stream. Two checks:

- Per call: `result.dflashStats !== undefined` and
  `result.dflashStats.drafted > 0`.
- Process-wide: `dflashTurnHistory.snapshot()` exposes the rolling window;
  `acceptanceQuantiles()` returns null when every recent turn drafted zero
  (which is the signal that native events never fired). The voice-bench
  harness registers a listener via `dflashTurnHistory.addListener` to
  write per-turn JSONL summaries.

Logging: each finalized turn emits
`[DflashMetricsCollector] turn summary {drafted, accepted, rounds, acceptanceRate, eventCount, durationMs}`
through the structured logger. A turn that lands in this log with `eventCount > 0`
is confirmation that native events drove the stream.

## Rollout plan

1. **JS side — landed.** Schema parser, metrics collector, rolling history,
   feature flag plumbing, tests. Default off — no behavior change in
   production.
2. **C side — pending merge.** Reference sketch in the protocol spec;
   `tools/server/server.cpp` advertises capability, `tools/server/server-task.cpp`
   emits events from inside the speculative-decoding loop. Build flag:
   `LLAMA_DFLASH_NATIVE_EVENTS`.
3. **Bundle opt-in.** Once a bundle's C-side build ships, set
   `runtime.optimizations.nativeDflashEvents = true` on that bundle in the
   catalog (`packages/shared/src/local-inference/catalog.ts`). Older
   binaries continue to use synthesis because the runtime probe will
   downgrade automatically.
4. **Autotuner switchover.** When p50 acceptance from
   `dflashTurnHistory.acceptanceQuantiles()` is stable across at least 32
   turns, replace the `/metrics`-diff input in the draft-window autotuner
   with the rolling-history value.

## Files

- Schema + validators: `packages/app-core/src/services/local-inference/dflash-event-schema.ts`
- Metrics + rolling history: `packages/app-core/src/services/local-inference/dflash-metrics-collector.ts`
- SSE parser wiring: `packages/app-core/src/services/local-inference/dflash-server.ts` (`fetchStreamingChatCompletion`, `runGenerate`, `probeNativeDflashEventsCapability`, `nativeDflashEventsEnabled`)
- Catalog flag: `packages/shared/src/local-inference/types.ts` (`LocalRuntimeOptimizations.nativeDflashEvents`)
- Wire format: [`dflash-native-events-protocol.md`](./dflash-native-events-protocol.md)
- Tests: `packages/app-core/src/services/local-inference/dflash-event-schema.test.ts`, `dflash-metrics-collector.test.ts`, plus a "native dflash events" scenario in `dflash-server.test.ts`
