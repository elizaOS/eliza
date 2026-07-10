# gpt-5.5 trajectory-training harvest pipeline

Stage 2 corpus harvest for the gpt-5.5 → eliza-1 training pipeline. Runs the
elizaOS test/eval corpus through gpt-5.5 (Codex subscription), captures every
run as an `eliza_native_v1` trajectory + pass/fail verdict, so Stage 3 can
GEPA-repair the failures and Stage 4 can extract the passes into training data.

**Stage 1 status:** inventory + wiring + driver proven on a small slice. The
full corpus is NOT run here.

## Files

| File | Role |
|---|---|
| `build-manifest.mjs` | Enumerates the whole corpus → `manifest.json` (families, items, run commands, trajectory landing). Discover-only; runs nothing. |
| `manifest.json` | Machine-readable corpus manifest (generated). |
| `harvest-runner.mjs` | Stage-2 driver. Consumes the Stage-1 provider incantation, iterates the manifest, runs each item, captures trajectory + verdict into `harvest/`. |
| `s1-provider.example.json` | Example provider-env the driver consumes (`{ELIZA_CHAT_VIA_CLI:"codex", ELIZA_CLI_CODEX_MODEL:"gpt-5.5"}`). Stage-1 leg S1 emits the real one. |

## Provider seam (how gpt-5.5-via-Codex slots in)

The scenario runner already has a first-class CLI-subscription provider
(`packages/core/src/testing/live-provider.ts` → `selectCliProvider`). Setting
`ELIZA_CHAT_VIA_CLI=codex` selects provider `"cli"`, model `gpt-5.5`, plugin
`@elizaos/plugin-cli-inference`, which reads `~/.codex/auth.json` itself — no API
key ever passes through eliza. The driver injects this env per spawn; it is
never hard-coded. Precedence: `--provider-env <s1.json>` → `$HARVEST_PROVIDER_ENV_FILE`
→ inherited `ELIZA_CHAT_VIA_CLI`/API key → `--deterministic` (offline self-test).

## Families & trajectory emission

- **scenario** — `@elizaos/scenario-runner` drives a real `AgentRuntime`+PGLite.
  Emits `eliza_native_v1` **natively** via `--export-native`. Verdict per
  scenario id (`report.scenarios[].status`, mirrored to `native row.scenarioStatus`).
  978 base scenario ids across 7 dirs (~10,716 with persona expansion).
- **benchmark** — `packages/benchmarks` orchestrator, 53 adapters. Emits
  per-benchmark result JSON today. Native trajectories require wiring: the ~25
  `eliza-adapter`-routed benchmarks boot a real runtime; set
  `ELIZA_SAVE_TRAJECTORIES=1 ELIZA_TRAJECTORY_DIR=<dir>` then convert `<dir>`
  with scenario-runner `native-export`. Python-only/`standard/*` benchmarks
  don't boot the runtime and can't emit native trajectories.
- **e2e** — 51 `*.live.e2e.test.ts` / `*.real.e2e.test.ts` vitest lanes that
  drive a real runtime. Same trajectory wiring as benchmarks; verdict is coarse
  (vitest pass/fail per file).

Only the **scenario** family emits `eliza_native_v1` today, so the driver
executes that family in Stage 1. Benchmark/e2e are enumerated with their wiring
notes for Stage 2.

## Harvest layout (what Stage 2 writes)

```
<repo>/reports/training-harvest/gpt55/harvest/
  <family>/<dir-slug>/<item-slug>/
      report.json                 scenario aggregate report (per-scenario status)
      native.jsonl                eliza_native_v1 rows (scenarioStatus + judgeScore)
      native.jsonl.manifest.json
      verdict.json                { item, status, rows, judgeScore, exitCode }
      run/trajectories/**         RecordedTrajectory JSON (source for native export)
      stdout.log / stderr.log
  harvest-summary-<run|dryrun>-<ts>.json
```

## Usage

```bash
# rebuild the manifest
node scripts/training-harvest/build-manifest.mjs

# driver self-test (offline, deterministic proxy)
node scripts/training-harvest/harvest-runner.mjs --deterministic --limit 3 --dry-run

# STAGE 2 real harvest (consumes S1's proven provider env)
node scripts/training-harvest/harvest-runner.mjs \
  --provider-env <s1-output.json> --family scenario
```

Prereq in a fresh worktree: generate the i18n keyword data once —
`node packages/shared/scripts/generate-keywords.mjs` (gitignored
build artifact; the CLI imports `packages/core/src/i18n/generated/`).
