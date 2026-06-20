# Mobile Resource Workbench

End-to-end on-device resource profiling for elizaOS local inference on **iOS +
Android**: battery drain, peak/steady RSS, prefill/decode tokens/sec, TTFT,
thermal-state timeline, and low-power transitions — with per-tier budgets, a
regression gate, and a report. Mirrors the `loadperf` budgets/results/CI-gate
discipline (issue #8800).

`loadperf` measures host load/boot performance; this measures the *phone*.

## What it captures

| Signal | Source |
| --- | --- |
| prefill / decode / combined tok/s | device-bridge `generateResult` differenced by `computeGenerationThroughput` (TTFT split), harvested from `/api/dev/device-resource-metrics` |
| TTFT | on-device first-token wall-clock (capacitor adapter → device bridge) |
| peak / steady RSS + leak flag | native `getResourceSnapshot` (iOS `phys_footprint` / Android total PSS) + host probes (`adb dumpsys meminfo`) |
| battery drain (% + µAh) | Android `BatteryManager` / `dumpsys battery`; iOS `UIDevice` battery (physical only) |
| thermal-state timeline + transitions | iOS `ProcessInfo.thermalState` / Android `PowerManager.getCurrentThermalStatus` sampled over the run |
| low-power-mode transitions | iOS `isLowPowerModeEnabled` / Android `isPowerSaveMode` |
| CPU / energy (nightly trend) | iOS MetricKit (`MXMetricPayload`); Android `dumpsys batterystats` |

Anything the OS can't report is recorded as `null` — never a fabricated `0`.

## Run

```bash
# Auto-detect an attached device (adb / booted simulator); default workloads.
node packages/benchmarks/mobile-resource/run-workbench.mjs

# Pin platform + tier + device class:
node packages/benchmarks/mobile-resource/run-workbench.mjs \
  --platform=android --tier=eliza-1-0_8b --device-class=android-phone

# Pick workloads (voice loop is opt-in, needs MOBILE_RESOURCE_VOICE=1):
node packages/benchmarks/mobile-resource/run-workbench.mjs \
  --workloads=cold-load,single-turn,sustained-chat

# Consolidated report (markdown + HTML) from the latest results:
node packages/benchmarks/mobile-resource/report.mjs
```

Exit codes: `0` pass, `1` budget/gate failure, `2` skipped/unavailable (no
device/agent) — usable directly as a CI gate. When no device or agent is
reachable the runner records `{ skipped }` and exits `2` rather than failing.

## Workloads

| id | what it stresses |
| --- | --- |
| `cold-load` | cold model load → peak RSS at load |
| `single-turn` | one short chat → TTFT + prefill/decode tok/s + single-turn RSS |
| `sustained-chat` | N short turns → RSS-leak window + thermal creep + battery drain |
| `voice-loop` | full voice round-trips → voice TTFT (tied to #8785 / #8786; opt-in) |

## Layout

| Path | Role |
| --- | --- |
| `run-workbench.mjs` | Runner: drives workloads, samples resources, checks budgets, writes results |
| `metrics.mjs` | Pure aggregation + budget logic (`summarizeResourceRun`, `checkBudgets`, `computeThroughput`) |
| `metrics.test.mjs` | `node --test` unit tests for the aggregation/budget logic |
| `workloads.mjs` | Canonical workload definitions |
| `android-probe.mjs` | Host-side adb probes (thermal/battery/memory) |
| `ios-probe.mjs` | simctl device detect + MetricKit payload pull |
| `report.mjs` | Consolidated markdown/HTML report from `results/` |
| `lib.mjs` | Shared utilities (result recording, git context, formatting, exec) |
| `budgets.json` | Per device-class × tier budgets |
| `BASELINE.md` | Measured baselines + how a baseline becomes a budget |
| `results/` | Timestamped JSON + report (gitignored; only `.gitignore` committed) |

## Test the harness

```bash
node --test packages/benchmarks/mobile-resource/metrics.test.mjs
```

The pure aggregation + budget logic is unit-tested here; the device-driving
runner and probes degrade to `skipped` off-device, so they are exercised in the
`mobile-resource-workbench` CI lane on the self-hosted arm64 runner + iOS sim.

## Notes

- Not registered in the suite orchestrator — run directly with `node`, same as
  `loadperf`.
- Budgets in `budgets.json` start mostly `null` (no baseline yet); fill them in
  from `BASELINE.md` as on-device numbers stabilise, then ratchet down.
- CI: `.github/workflows/mobile-resource-workbench.yml` (`workflow_dispatch` +
  nightly), self-hosted arm64 Android lane + iOS-sim lane, uploads the report +
  raw traces. Kept off PR-blocking lanes until baselines are stable.
