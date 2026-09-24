# gpt-5.5 trajectory-training harvest pipeline

Stage 2 corpus harvest for the gpt-5.5 → eliza-1 training pipeline. Runs the
elizaOS test/eval corpus through the configured API model, captures every
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
| `s1-provider.example.json` | Example model settings; supply credentials separately. |

## Provider configuration

Use a supported API provider with credentials supplied through the environment.
The example provider file selects OpenAI models; it contains no credentials.
Pass `--provider-env <file.json>` or set `HARVEST_PROVIDER_ENV_FILE` to supply
provider settings. The driver otherwise uses inherited API credentials.
`--deterministic` runs the offline driver self-test without a model call.

## Families & trajectory emission

- **scenario** — `@elizaos/testing/scenario-runner` drives a real `AgentRuntime`+PGLite.
  Emits `eliza_native_v1` **natively** via `--export-native`. Verdict per
  scenario id (`report.scenarios[].status`, mirrored to `native row.scenarioStatus`).
  978 base scenario ids across 7 dirs (~10,716 with persona expansion).
- **benchmark** — moved to the standalone
  [elizaOS/benchmarks](https://github.com/elizaOS/benchmarks) repo; harvest
  benchmark trajectories from there.
- **e2e** — 51 `*.live.e2e.test.ts` / `*.real.e2e.test.ts` vitest lanes that
  drive a real runtime. Trajectory wiring: `ELIZA_SAVE_TRAJECTORIES=1 ELIZA_TRAJECTORY_DIR=<dir>` then scenario-runner `native-export`; verdict is coarse
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
node packages/scripts/training-harvest/build-manifest.mjs

# driver self-test (offline, deterministic proxy)
node packages/scripts/training-harvest/harvest-runner.mjs --deterministic --limit 3 --dry-run

# STAGE 2 real harvest (consumes S1's proven provider env)
node packages/scripts/training-harvest/harvest-runner.mjs \
  --provider-env <s1-output.json> --family scenario
```

Keyword data is authored in `packages/shared/src/i18n/keywords.ts`; there is no
keyword-generation prerequisite.

## Dataset extraction

Use `packages/training/scripts/extract_trajectory_to_native.py --require-pass`
with an explicit harvested input and output, then the training package's
`prepare_eliza1_trajectory_dataset.py` for dataset assembly and validation.
Inspect each command's `--help` for its input contract. Publication remains a
separate, explicit operation. The former stage-4 wrapper used a fixed historical
harvest path and upload namespace and is no longer supported.
