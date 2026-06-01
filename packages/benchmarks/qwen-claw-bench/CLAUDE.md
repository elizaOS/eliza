# QwenClawBench — Agent Guide

Real-user-distribution benchmark for general agent capabilities across 100 tasks
and 8 domains (workflow orchestration, system ops, knowledge management, quant
trading, data analysis, security, scheduling, research). Originally the internal
eval for Qwen3.6-Plus, open-sourced by Qwen Team + Alibaba Data. Not yet
registered in the suite registry — see `INTEGRATION.md` for the planned
`qwen_claw_bench` entry.

## Run

```bash
# From the qwen-claw-bench/ directory — requires Docker + openclaw_config/
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset qwenclawbench-v1.1-100 \
    --runs 3 \
    --concurrency 10 \
    --output-dir ./results/qwenclawbench-v1.1-100/qwen3.6-plus \
    --log-file logs/qwen-3.6-plus.log

# Equivalent direct invocation (run.sh is a thin wrapper):
python scripts/benchmark.py --model dashscope/qwen3.6-plus \
    --dataset qwenclawbench-v1.1-100 --concurrency 10

# Run a single task by ID:
python scripts/benchmark.py --model dashscope/qwen3.6-plus \
    --task task_00001_moltbook_social_media_explorer_skill

# Resume an interrupted run (same --output-dir, skips completed tasks):
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset qwenclawbench-v1.1-100 --runs 3 --concurrency 10 \
    --output-dir ./results/qwenclawbench-v1.1-100/qwen3.6-plus \
    --rerun-anomalous
```

## Test the harness

```bash
# No pytest suite — harness has no standalone tests.
# Smoke-check the benchmark.py CLI (no Docker, no API key):
cd qwen-claw-bench && python scripts/benchmark.py --help
```

## Layout

| Path | Role |
| --- | --- |
| `scripts/benchmark.py` | Main evaluation entry point (CLI + orchestration loop) |
| `scripts/run.sh` | Thin shell wrapper: `cd` to bench root, exec `benchmark.py "$@"` |
| `scripts/lib_tasks.py` | Task loader/parser (Markdown + YAML frontmatter) |
| `scripts/lib_docker.py` | Docker container lifecycle; workspace snapshot to `/tmp/qwenclawbench` |
| `scripts/lib_agent.py` | OpenClaw agent interaction, thinking-level handling |
| `scripts/lib_grading.py` | Automated + LLM-judge + hybrid scoring, pass@k stats |
| `scripts/lib_anomalies.py` | Anomaly detection (API errors, crashes, timeouts) |
| `data/qwenclawbench-v1.1-100/tasks/` | 100 `task_*.md` files with YAML frontmatter + grading code |
| `data/qwenclawbench-v1.1-100/assets/` | Per-task initial workspace directories (mounted into Docker) |
| `openclaw_config/openclaw.json` | Model/provider config (not committed — see `.env.example`) |
| `openclaw_config/.env` | API credentials (not committed — `DASHSCOPE_API_KEY` etc.) |

## Notes

- Requires Docker (`ghcr.io/openclaw/openclaw:main`) and Python >= 3.10.
  Install harness deps: `pip install pyyaml>=6.0.1 tqdm>=4.0`.
- Results write to `./results/<dataset>/<model>/` (gitignored). Workspace
  snapshots are isolated to `/tmp/qwenclawbench` (hard-coded).
- Scores are 0.0–1.0 per task, reported as percentages. Three `grading_type`
  modes: `automated`, `llm_judge`, `hybrid`. Hybrid applies penalized scoring
  (LLM-judge term is zeroed when automated score < 0.75). Use `--simple-scoring`
  to disable the penalty.
- Default judge model is `claude-opus-4.5`; configure in `openclaw.json`.
- Not registered in `registry/commands.py` yet. Planned key: `qwen_claw_bench`.
  See [INTEGRATION.md](INTEGRATION.md) for adapter design.
- Full background: [README.md](README.md).
