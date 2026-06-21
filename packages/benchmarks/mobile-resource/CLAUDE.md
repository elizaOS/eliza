# Mobile Resource Workbench — Agent Guide

On-device (iOS + Android) resource profiling harness: battery, RSS, prefill/decode
tok/s, TTFT, thermal timeline. Mirrors `loadperf`'s budgets/results/CI-gate
shape. Standalone Node ESM — run directly with `node`, not via the suite
orchestrator. Issue #8800.

## Run

```bash
node packages/benchmarks/mobile-resource/run-workbench.mjs            # auto-detect device
node packages/benchmarks/mobile-resource/run-workbench.mjs --platform=android --tier=eliza-1-0_8b
node packages/benchmarks/mobile-resource/report.mjs                   # consolidated report
```

Flags: `--platform=android|ios`, `--tier=eliza-1-0_8b|eliza-1-2b|eliza-1-4b`,
`--device-class=<budgets.json key>`, `--workloads=a,b,c`, `--base-url=<agent>`,
`--package=<android pkg>`, `--json`, `--fail-on-missing`.

Exit: `0` pass, `1` budget/gate fail, `2` skipped (no device/agent).

## Smoke test (no device, no keys)

```bash
node --test packages/benchmarks/mobile-resource/metrics.test.mjs   # pure aggregation + budgets
node packages/benchmarks/mobile-resource/report.mjs                # report from whatever results exist
```

Off-device the runner records `{ skipped }` and exits `2` — it never fabricates
numbers.

## Where the numbers come from

- **tok/s + TTFT** — the agent's device bridge differences `generateResult`
  (`computeGenerationThroughput`, in `@elizaos/shared/local-inference`) and
  buffers them; the runner reads `GET /api/dev/device-resource-metrics`.
- **RSS / thermal / battery / low-power** — native `getResourceSnapshot`
  (`ElizaIntent` on iOS, `ResourceProbe` on Android) + host probes
  (`android-probe.mjs` via adb; `ios-probe.mjs` via simctl + MetricKit).

## Conventions

- **Never fabricate a missing measurement.** Unmeasured → `null`, surfaced as
  `—` in reports and recorded as `not-measured` in budget checks (which pass by
  default; use `--fail-on-missing` to fail closed).
- **Budgets are per device-class × tier** in `budgets.json`; `null` budget =
  no-baseline (recorded, never fails). Ratchet in from `BASELINE.md`.
- **Results are generated, not committed** (`results/` is gitignored; only
  `.gitignore` is tracked).
- Pure aggregation/budget logic lives in `metrics.mjs` and is unit-tested with
  `node --test`. Keep device-driving glue in the runner/probes.

See the root [AGENTS.md](../../../AGENTS.md) for repo-wide rules and the issue
#8800 acceptance criteria.
