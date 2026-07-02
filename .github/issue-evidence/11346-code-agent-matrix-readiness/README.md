# #11346 — code-agent benchmark matrix keyless readiness (gemma-4-31b via Cerebras)

Readiness evidence for running `swe_bench` + `terminal_bench` on `gemma-4-31b`
through the orchestrator coding-agent path (`benchmarks.orchestrator.code_agent_matrix`,
adapter `elizaos`).

**Honesty note: nothing in this directory is a model run.** Every artifact here
is a dry-run, mock, oracle (reference-solution) smoke, or build proof. They prove the
harness plumbing, packaging, adapter selection, and artifact pipeline work
end-to-end without a model. They are validation artifacts per the runbook
(`packages/benchmarks/ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md`), not
reportable benchmark evidence.

## What was broken, and what was fixed

- `packages/benchmarks/swe_bench/pyproject.toml` declared
  `readme = "RESEARCH.md"`, but that file was deleted in the repo-wide
  "remove unreferenced markdown files" chores. This made
  `pip install -e packages/benchmarks/swe_bench` fail at metadata build time,
  blocking the whole harness install. Fixed to `readme = "README.md"`.
- Audited every other `pyproject.toml` under `packages/benchmarks/` for the
  same dead-readme bug (`grep 'readme ='` + file-existence check): swe_bench
  was the only one broken. `webshop` and `vending-bench` also reference
  `RESEARCH.md`, but their copies still exist on disk.
- No other packaging bugs surfaced; both harnesses now install cleanly.

## Artifacts

| File | What it is |
| --- | --- |
| `pip-install-proof.log` | `uv pip install -e swe_bench[dev] -e terminal-bench[dev]` into a fresh Python 3.12 venv (`/home/shaw/.venvs/eliza-bench`). Resolved + installed 104 packages, exit 0. Both harness wheels built — proof the pyproject fix unblocked packaging. |
| `dry-run-matrix.log` | Orchestrator matrix `--dry-run --smoke --no-docker --max-tasks 1 --benchmarks swe_bench,terminal_bench --adapters elizaos --provider cerebras --model gemma-4-31b`. Exit 0. |
| `dry-run-summary.json` / `dry-run-summary.md` | Matrix output for the dry-run: one cell per (benchmark × adapter), both `status: "dry_run"`, per-cell `command.json`/logs written, coverage block populated. Validates wiring + adapter selection, **no model involved**. |
| `swe-bench-mock-smoke.log` | `python -m benchmarks.swe_bench.cli --mock --no-docker --max-instances 1`. Runs the synthetic smoke instance through the real harness code path (workspace, repo manager, patch apply, report writer). Exit 0, 1/1 resolved — **synthetic instance, mock adapter, no model**. |
| `terminal-bench-mock-smoke.log` | `terminal-bench --use-sample-tasks --local-sandbox --mock --model-provider mock --max-tasks 2`. Built-in sample tasks in a local sandbox with the always-success mock environment. Exit 0, 2/2 — **sample tasks + mock env, explicitly NOT Terminal-Bench grading, no model**. |
| `terminal-bench-oracle-smoke.log` | `terminal-bench --oracle --task-ids analyze-access-logs --verbose` against the real vendored Terminal-Bench corpus (241 tasks loaded) in real Docker. Built the per-task image `elizaos-tbench/analyze-access-logs:latest` from the task's Dockerfile, started a real container, executed the task's reference solution through the default tmux-session environment, and graded it with the real test harness. Exit 0, 1/1 passed, 21.5s. **Reference solution, no model.** |
| `terminal-bench-oracle-report.json` / `terminal-bench-oracle-report.md` | The JSON + Markdown reports the oracle run wrote (task result, commands, timing). |
| `ts-build-turbo.log` | `ELIZA_SKIP_ARTIFACT_SYNC=1 bun install && bunx turbo build --filter=@elizaos/plugin-agent-orchestrator... --filter=@elizaos/app-core...` from this branch. 96/96 turbo tasks successful, exit 0, 3m56s (trimmed head + tail of the full log). |

## What this proves

- The swe_bench packaging bug is fixed; both Python harnesses install cleanly
  from the repo with `uv` into a fresh 3.12 venv.
- The orchestrator matrix CLI resolves both benchmark cells for the `elizaos`
  adapter with provider `cerebras` / model `gemma-4-31b` and writes the full
  artifact tree (summary.json/md, per-cell command.json, stdout/stderr, report
  rows, viewer).
- Each harness's own plumbing (dataset/task loading, environment setup,
  execution loop, grading, report generation) works end-to-end without a
  model, via its deepest keyless mode.
- The TS side (`@elizaos/plugin-agent-orchestrator`, `@elizaos/app-core`)
  builds from this branch (`bunx turbo build` scoped to both packages: 96/96
  tasks successful, exit 0 — `ts-build-turbo.log`), and the oracle smoke
  actually booted the elizaOS benchmark bridge server from
  `packages/app-core` (`ELIZA_BENCH_READY` in
  `terminal-bench-oracle-smoke.log`).

## The ONLY remaining blocker

`CEREBRAS_API_KEY` is not present on this host. It is the exact env var the
matrix requires for `--provider cerebras`
(`packages/benchmarks/orchestrator/code_agent_matrix.py`, provider→env map).
It is operator-provisioned; nothing in the repo can fix it. Everything else —
Docker (29.6.1, up), the vendored terminal-bench corpus (241 tasks loaded by
the dataset loader in the oracle run), the
historical plugin-goals / plugin-openai blockers (gone on develop), harness
packaging, python deps, and the TS bridge build — is ready.

## Exact operator commands for the real run

All commands from the repo root, with the venv from this readiness work.
Source: `packages/benchmarks/ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md`.

```bash
export CEREBRAS_API_KEY=...   # never commit; env only
cd packages
```

Preflight (writes preflight.json/preflight.md, exits before running cells):

```bash
/home/shaw/.venvs/eliza-bench/bin/python -m benchmarks.orchestrator.code_agent_matrix \
  --preflight \
  --benchmarks swe_bench,terminal_bench \
  --adapters elizaos \
  --provider cerebras \
  --model gemma-4-31b \
  --max-tasks 1 \
  --no-docker
```

Real 1-instance slice (the #11346 scope — swe_bench + terminal_bench, elizaos adapter):

```bash
/home/shaw/.venvs/eliza-bench/bin/python -m benchmarks.orchestrator.code_agent_matrix \
  --benchmarks swe_bench,terminal_bench \
  --adapters elizaos \
  --provider cerebras \
  --model gemma-4-31b \
  --max-tasks 1 \
  --no-docker \
  --timeout-seconds 3600
```

Drop `--no-docker` to let terminal_bench grade inside real task containers
(Docker is up on this host) and to enable swe_bench docker evaluation.

Full publishable matrix per the runbook (all seven benchmarks, three adapters,
three passes, then the longitudinal trend). These run with Docker enabled —
`osworld` requires it, and preflight rejects `--no-docker` for osworld unless
an alternate `OSWORLD_PROVIDER_NAME` is configured:

```bash
/home/shaw/.venvs/eliza-bench/bin/python -m benchmarks.orchestrator.code_agent_matrix \
  --preflight \
  --benchmarks swe_bench,swe_bench_multilingual,terminal_bench,mind2web,visualwebbench,webshop,osworld \
  --adapters elizaos,opencode,pi-agent \
  --provider cerebras \
  --model gemma-4-31b \
  --max-tasks 1

for i in 1 2 3; do
  /home/shaw/.venvs/eliza-bench/bin/python -m benchmarks.orchestrator.code_agent_matrix \
    --benchmarks swe_bench,swe_bench_multilingual,terminal_bench,mind2web,visualwebbench,webshop,osworld \
    --adapters elizaos,opencode,pi-agent \
    --provider cerebras \
    --model gemma-4-31b \
    --max-tasks 1 \
    --force
done

# Longitudinal trend: re-summarize the latest run against a previous run's
# summary.json; --enforce-no-regression exits nonzero on accuracy regression.
/home/shaw/.venvs/eliza-bench/bin/python -m benchmarks.orchestrator.code_agent_matrix \
  --summarize benchmark_results/code-agent-matrix/<latest-run> \
  --compare-summary benchmark_results/code-agent-matrix/<previous-run>/summary.json \
  --enforce-no-regression
```

Before publishing, add the enforcement stack from the runbook
(`--enforce-live-report --enforce-trajectory-reviews --enforce-report
--enforce-coverage --enforce-comparable --enforce-required-stats
--enforce-token-evidence --enforce-efficiency --enforce-release-readiness`)
to the run command.

Every `code_agent_matrix` command above was executed on this host to confirm
it parses and runs: the preflights exit 2 (`preflight_failed`) with
`missing_provider_key: CEREBRAS_API_KEY` as the only blocking issue; the run
commands exit 0 under `--dry-run` (the full 7×3 matrix resolves 21 dry-run
cells); the trend command exits 0 against a dry-run root, attaching
`previous_summary_comparison` and an enforced-passing `no_regression_gate`.

To recreate the venv from scratch (what this readiness pass did):

```bash
/home/shaw/.local/bin/uv venv /home/shaw/.venvs/eliza-bench --python 3.12
/home/shaw/.local/bin/uv pip install --python /home/shaw/.venvs/eliza-bench/bin/python \
  -e "packages/benchmarks/swe_bench[dev]" \
  -e "packages/benchmarks/terminal-bench[dev]"
```
