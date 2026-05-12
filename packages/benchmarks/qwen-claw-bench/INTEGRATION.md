# QwenClawBench — Integration Notes

Source repo: https://github.com/SKYLENAGE-AI/QwenClawBench
Dataset on HF: https://huggingface.co/datasets/skylenage-ai/QwenClawBench
Leaderboard: https://skylenage-ai.github.io/QwenClawBench-Leaderboard/
License: MIT
Cloned at: 2026-05-12, `--depth 1`, `.git` and `.github` stripped. ~11 MB total. No files > 10 MB.

## What it evaluates

Real-user-distribution benchmark for **general agent capabilities**, originally an internal eval used during the development of Qwen3.6-Plus and now open-sourced. Targets [OpenClaw](https://github.com/openclaw/openclaw) agents specifically (the runner shells into `ghcr.io/openclaw/openclaw:main`), but the task definitions themselves are runner-agnostic Markdown + YAML + an optional Python `grade(...)` block, so they can be driven by any agent harness that mounts the workspace and captures a transcript.

100 tasks across 8 domains:

| Domain | Count |
|---|---|
| Workflow and Agent Orchestration | 21 |
| System Operations and Administration | 20 |
| Knowledge and Memory Management | 15 |
| Finance and Quantitative Trading | 10 |
| Data Analysis and Modeling | 10 |
| Security and Vulnerability Management | 9 |
| Communication and Scheduling | 8 |
| Research and Information Retrieval | 7 |

Tasks include skill creation, workflow orchestration, system troubleshooting, knowledge-base construction, quant strategy backtesting, security audits, scheduling, and competitive research — all in isolated simulated workspaces under `data/qwenclawbench-v1.1-100/assets/<task_id>/`.

## Dataset size / source

- **100 tasks** in `data/qwenclawbench-v1.1-100/tasks/task_*.md`
- **100 asset directories** in `data/qwenclawbench-v1.1-100/assets/task_*/` (initial workspace files: code, configs, data, logs)
- Total payload: ~11 MB on disk after `.git` strip
- Tasks are Markdown files with YAML frontmatter (id, name, category, subcategory, grading_type, grading_weights, timeout_seconds, workspace_files) and structured body sections (`## Prompt`, `## Expected Behavior`, `## Grading Criteria`, `## Automated Checks`, `## LLM Judge Rubric`)
- Built on top of the [PinchBench](https://github.com/pinchbench/skill) framework. Related: Claw-Eval, ZClawBench, WildClawBench.

## Runner interface

Entry point: `scripts/benchmark.py` (also wrapped by `scripts/run.sh`).

```bash
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset qwenclawbench-v1.1-100 \
    --runs 3 \
    --concurrency 10 \
    --output-dir ./results/qwen3.6-plus \
    --log-file logs/qwen-3.6-plus.log
```

Key flags: `--model`, `--dataset`, `--task` / `--suite`, `--runs` (multiple runs per task; results averaged), `--concurrency` (parallel Docker containers), `--output-dir`, `--rerun-anomalous`, `--no-resume`, `--simple-scoring`.

Library modules (`scripts/lib_*.py`):
- `lib_tasks.py` — task loader / parser
- `lib_docker.py` — container lifecycle, workspace snapshot management (snapshots restricted to `/tmp/qwenclawbench`)
- `lib_agent.py` — OpenClaw agent interaction, thinking-level handling
- `lib_grading.py` — automated + LLM-judge + hybrid scoring, pass@k
- `lib_anomalies.py` — anomaly detection (API errors, container crashes, timeouts)

Resumable: re-running with the same `--output-dir` skips healthy completed tasks. `--rerun-anomalous` re-executes only flagged failures.

## Scoring metric — IMPORTANT

**Raw range is 0.0–1.0 per task** (not the 1068–1536 range the user's table mentioned — that was QwenWebBench's Elo, see below). Aggregate leaderboard scores are typically reported as **percentages (0–100)**, which matches the user's table value `41–53` for QwenClawBench.

Three scoring modes per task (`grading_type` in frontmatter):

1. **`automated`** — embedded Python `grade(transcript, workspace_path) -> dict` performs deterministic rule-based checks (output files, command results, workspace state). Final score = mean across checked dimensions, ∈ [0.0, 1.0].
2. **`llm_judge`** — Claude-opus-4.5 (default judge) reviews the action transcript against a rubric, scoring each dimension 0.0–1.0. Final score = weighted average.
3. **`hybrid`** — combines the above using `grading_weights` from frontmatter, with a **penalized scoring** rule:
   ```
   score = w_auto · s_auto + w_llm · s_llm · 𝟙[s_auto ≥ 0.75]
   ```
   The LLM-judge term is zeroed out when the automated score is below 0.75 — i.e. an agent that fails deliverable checks gets no credit for fluent-but-incorrect reasoning. `--simple-scoring` disables this and falls back to plain weighted average.

Pass@k stats are also computed (see `lib_grading.pass_k_stats`).

The 41–53 range in the user's table is consistent with reported pass rates × 100 for current frontier models on this benchmark (Qwen3.6-Plus, GPT-5.5, Claude Opus 4.7 class).

## Sandbox / environment requirements

- **Docker required.** Image: `ghcr.io/openclaw/openclaw:main`. Each task runs in its own container, with the task's asset directory copied into the container workspace at `/home/node/.openclaw/workspace`.
- **Python ≥ 3.10**, deps: `pyyaml>=6.0.1`, `tqdm>=4.0` (plus whatever the embedded `grade(...)` functions import — they execute in the host runner, not the container).
- **OpenClaw config**: `openclaw_config/openclaw.json` (model + provider catalog, gateway settings) and `openclaw_config/.env` (API credentials — `DASHSCOPE_API_KEY` for Qwen, plus whatever the judge model needs).
- **Snapshot root**: `/tmp/qwenclawbench` (hard-coded `_WORKSPACE_SNAPSHOT_ROOT` in `scripts/benchmark.py`).
- Default model in the example config is `dashscope/qwen3.6-plus`. Swap the provider block for `openai`, `anthropic`, etc. to evaluate other models.

The runner assumes OpenClaw is the agent under test. The OpenClaw gateway runs inside the container on port `18789` with token auth (`openclaw.json` → `gateway`).

## Integration plan — adapters

Existing adapter dirs in `packages/benchmarks/`:

- `eliza-adapter/` — wraps Eliza/elizaOS runtime as a benchmark target (see `eliza_adapter/`, currently has an `osworld_adapter.py` shim for OSWorld).
- `hermes-adapter/` — wraps the Hermes agent runtime, with a thin CLI (`run_env_cli.py`).
- `openclaw-adapter/` — wraps OpenClaw as a benchmark target — **this is the natural drop-in for QwenClawBench since the upstream runner already targets OpenClaw**.

Recommended integration:

1. **Native path (openclaw-adapter)**. Drive the upstream `scripts/benchmark.py` end-to-end through `openclaw-adapter` by:
   - Pointing the `--model` arg at the model identifier our adapter exposes (e.g. `milady-local/qwen3.6-plus-gguf`).
   - Generating an `openclaw.json` that registers our local provider (Ollama / vLLM / Eliza Cloud) and binding `DASHSCOPE_API_KEY` (or the equivalent) via `openclaw_config/.env`.
   - Mounting our `/tmp/qwenclawbench` snapshot dir as a tmpfs in CI to keep evaluation hermetic.
   - Parsing `results/<dataset>/<slugified-model>/summary.json` for the pass-rate aggregates (∈ [0,1], multiply by 100 for the leaderboard percentage).

2. **Non-OpenClaw path (eliza-adapter, hermes-adapter)**. The task format is runner-agnostic, but `scripts/benchmark.py` hard-codes OpenClaw container orchestration. Two options:
   - **Adapter shim** (preferred). Add a `qwen_claw_bench_runner.py` in each adapter that:
     1. Loads tasks via `lib_tasks.TaskLoader`.
     2. Copies the asset dir into a fresh workspace.
     3. Invokes the adapter's agent with `task.prompt`, captures the transcript JSONL.
     4. Calls `lib_grading.grade_task(...)` on the transcript + workspace.
   - **Wholesale fork of `benchmark.py`** — only if the OpenClaw-specific code paths (`lib_docker`, `lib_agent` thinking-level handling) become a blocker. Avoid; prefer the shim.

3. **Registry entry**. Add a row to `packages/benchmarks/registry.py` (single source of truth in this repo for benchmark configs). Suggested key: `qwen_claw_bench`, with `dataset_path = "qwen-claw-bench/data/qwenclawbench-v1.1-100"`, `entry = "qwen-claw-bench/scripts/benchmark.py"`, `score_range = (0.0, 1.0)`, `report_as_percent = True`.

4. **CI gating**. Pin `--runs 3 --concurrency 10` for full-suite runs; `--suite <single_task_id>` for smoke tests. Anomaly detection (`lib_anomalies`) should be treated as run-fatal — infrastructure failures must not silently lower scores.

## Confidence levels

- **High** confidence: repo identity (`SKYLENAGE-AI/QwenClawBench`), dataset structure, runner interface, scoring math, Docker requirement, license. Sourced directly from README + scripts + HF dataset card.
- **High** confidence: scoring range 0.0–1.0 raw, percentage when aggregated. The user's `41–53` table values are consistent with reported pass rates × 100.
- **Medium** confidence: best adapter target is `openclaw-adapter` because OpenClaw is the upstream-supported runner. Confirm by reading the existing adapter's interface before wiring.
