# Trajectory Collection Runbook

`packages/training/scripts/collect_trajectories.py` is a development
orchestrator for collecting trajectories through existing entry points. It is
provider/model agnostic: provider and model values are recorded as labels, and
the collector only exports known model override env vars for the selected
provider (`CEREBRAS_MODEL`, `OPENAI_MODEL`/`OPENAI_LARGE_MODEL`, or
`ANTHROPIC_MODEL`/`ANTHROPIC_LARGE_MODEL`) when the operator explicitly passes
`--model`.

## What It Runs

Supported suites:

- `live-scenarios` invokes `node scripts/run-live-scenarios.mjs` with
  `--run-dir` and `--runId`.
- `scenario-benchmark` invokes `node scripts/run-scenario-benchmark.mjs` and
  points its JSON/Markdown reports at the collection run directory.
- `scenario-runner` invokes `bun --bun packages/scenario-runner/src/cli.ts run`
  directly with `--run-dir`, `--runId`, `--report`, and `--report-dir`.
- `lifeops-bench` invokes the active Python interpreter with
  `-m eliza_lifeops_bench` from
  `packages/benchmarks/lifeops-bench` with `--max-cost-usd`.

Every invocation writes `<output-dir>/<run-id>/collection-manifest.json`,
including dry-runs. The manifest records commands, env requirements, env
overrides, expected output paths, provider labels, cost-cap handling, git
metadata, app trajectory export references, and the downstream prepare command.
Run it with the training package Python environment (`>=3.11`).

The stable top-level manifest contract is:

- `schema`, `version`, `run_id`, `generated_at`, and `completed_at`
- `provider_label` and nullable `provider_model`
- `suites`, `commands`, `expected_outputs`, and `cost_caps`
- `git` and `worktree`
- `downstream_inputs.app_trajectory_export`, including the native JSONL export
  endpoint/body and a suggested output path
- `downstream_inputs.prepare_eliza1_trajectory_dataset`, including
  `input_paths`, `ready_input_paths`, `pending_input_paths`, `output_dir`, and
  the prepare command

The collector is manifest-only unless `--execute` is present. Use `--dry-run`
when you want that intent to be visible in command history; otherwise omitting
`--execute` has the same no-run behavior.

The run id is always exported as `ELIZA_COLLECTION_RUN_ID` and
`ELIZA_LIFEOPS_RUN_ID`. Entry points with a native run-id flag also receive
`--runId <run-id>` or `--run-id <run-id>` so recorder files, reports, and
aggregation filters line up.

## Provider Labels

Built-in labels are `env`, `cerebras-dev`, `openai`, `anthropic`,
`openai-placeholder`, and `opus-placeholder`.

`cerebras-dev` is only a development backend label. It does not pin
`gpt-oss-120b`; pass `--model` when you want the collector to export
`CEREBRAS_MODEL` for LifeOpsBench `cerebras-direct` runs.

`openai-placeholder` and `opus-placeholder` are config labels only. The
collector refuses non-dry runs whose active model or judge model contains
`opus`, so Opus can appear in a manifest as planning metadata without being
executed by this script.

For `--provider anthropic`, pass an explicit non-Opus `--model`; the collector
blocks `--execute` Anthropic runs without one to avoid falling through to an
Opus default configured elsewhere. Opus labels can be prepared in a dry-run
manifest, but `--execute` runs with an active or judge model containing `opus`
are blocked before any suite starts. The execute path also refuses known
model-selection environment variables containing `opus` (for example
`ANTHROPIC_LARGE_MODEL` or `JUDGE_MODEL`) unless the collector's own explicit
non-Opus override replaces them.

The older action-trajectory harness under
`packages/training/scripts/harness/` is also provider/model configurable. Run
it as a module and pass `--model`, `--api-url`, `--api-key-env`, and
`--provider-label`, or set `ELIZA_HARNESS_MODEL`,
`ELIZA_HARNESS_API_URL`, `ELIZA_HARNESS_API_KEY_ENV`, and
`ELIZA_HARNESS_PROVIDER`. Its default remains the development Groq-compatible
endpoint only as a fallback.

## Dry-Run

```bash
python3 packages/training/scripts/collect_trajectories.py \
  --dry-run \
  --provider cerebras-dev \
  --model <dev-model-id> \
  --suites live-scenarios,scenario-runner,lifeops-bench \
  --run-id dev-trajectories-001 \
  --output-dir artifacts/trajectory-collection \
  --max-cost-usd 2
```

Inspect:

```bash
jq . artifacts/trajectory-collection/dev-trajectories-001/collection-manifest.json
```

## Live Scenario Collection

```bash
ELIZA_LIVE_TEST=1 CEREBRAS_API_KEY=... \
python3 packages/training/scripts/collect_trajectories.py \
  --execute \
  --provider cerebras-dev \
  --model <dev-model-id> \
  --suites live-scenarios \
  --scenario-filter reminder.followup.basic \
  --run-id live-smoke-001 \
  --output-dir artifacts/trajectory-collection \
  --max-cost-usd 1
```

Expected outputs include:

- `artifacts/trajectory-collection/live-smoke-001/trajectories/`
- `artifacts/trajectory-collection/live-smoke-001/reports/live-scenarios.json`
- `artifacts/trajectory-collection/live-smoke-001/matrix.json`

## Scenario Benchmark

```bash
ELIZA_LIVE_TEST=1 OPENAI_API_KEY=... \
python3 packages/training/scripts/collect_trajectories.py \
  --execute \
  --provider openai \
  --model <model-label> \
  --suites scenario-benchmark \
  --run-id benchmark-dev-001 \
  --output-dir artifacts/trajectory-collection
```

The benchmark wrapper does not expose a native cost cap. The collector records
the cap in the manifest for accounting, but only LifeOpsBench enforces
`--max-cost-usd`. If no cap is passed, LifeOpsBench still receives its
collector default of `$10`; the manifest records that as the suite's effective
cap. Non-positive caps are rejected before execution.

## Direct Scenario Runner

```bash
ELIZA_LIVE_TEST=1 OPENROUTER_API_KEY=... \
python3 packages/training/scripts/collect_trajectories.py \
  --execute \
  --provider env \
  --model <model-label> \
  --suites scenario-runner \
  --scenario-root plugins/app-lifeops/test/scenarios \
  --file-glob "plugins/app-lifeops/test/scenarios/*.scenario.ts" \
  --run-id direct-runner-001 \
  --output-dir artifacts/trajectory-collection \
  --aggregate
```

With `--aggregate`, the collector runs `scripts/aggregate-lifeops-run.mjs`
after scenario suites and expects `report.md`, `steps.csv`, and per-scenario
JSONL under the same run directory.

## LifeOpsBench Static Dev Run

```bash
CEREBRAS_API_KEY=... \
python3 packages/training/scripts/collect_trajectories.py \
  --execute \
  --provider cerebras-dev \
  --model <dev-model-id> \
  --suites lifeops-bench \
  --lifeops-agent cerebras-direct \
  --lifeops-mode static \
  --lifeops-domain reminders \
  --max-cost-usd 1 \
  --run-id lifeops-bench-static-001 \
  --output-dir artifacts/trajectory-collection
```

`--lifeops-mode` defaults to `static` to avoid accidental live judge calls. For
live mode, pass an explicit non-Opus `--judge-model`; the collector will not
fall through to the LifeOpsBench Opus default.

## Prepare Handoff

After collection, use the command embedded in
`downstream_inputs.prepare_eliza1_trajectory_dataset.command` as the Worker C
handoff. It points at the collection outputs that can become prepare inputs and
writes the prepared splits under
`packages/training/data/trajectory-runs/<run-id>/`.

Raw recorder directories such as `<run-dir>/trajectories/` are audit artifacts,
not direct Eliza-1 prep inputs. The manifest lists those under
`source_raw_trajectory_paths`. Convert or export them to `eliza_native_v1`
JSONL first; the suggested target path is recorded in
`downstream_inputs.app_trajectory_export.suggested_output_path` and repeated in
`prepare_eliza1_trajectory_dataset.pending_input_paths`.

Example:

```bash
jq -r '.downstream_inputs.prepare_eliza1_trajectory_dataset.command | @sh' \
  artifacts/trajectory-collection/<run-id>/collection-manifest.json
```

Review the listed `input_paths` and run privacy review before staging a dataset
candidate. The prepare command includes `--strict-privacy`; keep it unless a
reviewed synthetic-only bundle needs a documented exception.

Before running the candidate publisher for real-user data, keep the reviewed
source manifest or privacy attestation next to the reviewed split files. The
publisher auto-discovers `manifest.json` beside the three split files or one
directory above them, and records a path reference plus SHA-256 in the candidate
manifest. For strict privacy attestations, use
`schema: eliza.privacy_filter_attestation.v1`, `version: 1`, matching
input/output counts, zero residual findings, and a ledger artifact with
`raw_sensitive_values: false`.

## App Trajectory Export

For app/runtime trajectories, export native training rows from the Trajectories
view with **Export -> JSONL Native Training**, or call the API directly:

```bash
curl -sS -X POST http://localhost:3000/api/trajectories/export \
  -H 'content-type: application/json' \
  --data '{"format":"jsonl","includePrompts":true,"jsonShape":"eliza_native_v1"}' \
  > artifacts/trajectory-collection/<run-id>/exports/app-trajectories.eliza-native.jsonl
```

Run privacy filtering/review on that JSONL before passing it to the prepare or
SFT splitter commands. Do not use the raw recorder JSON directory as a
stand-in for the native export.

## Privacy And Training

Raw trajectories are collection artifacts, not training data. Before including
them in SFT or RL data, run the repo privacy filter path and schema validators.
The native SFT splitter expects redacted `eliza_native_v1` rows:

```bash
python3 packages/training/scripts/trajectories_to_sft.py \
  --input <redacted-eliza-native-json-or-jsonl> \
  --output-dir packages/training/data/sft-trajectories
```

Candidate staging is still a separate step. Run
`packages/training/scripts/publish_eliza1_dataset_candidate.py` first without
`--write` to dry-run schema, split, repair-row, and privacy-manifest checks.
Only add `--write` after the dry-run passes, and only add `--push
--allow-hf-push` when the remote candidate repo and token are intentional.
