# OpenClaw-Bench — Agent Guide

AI coding assistant benchmark evaluating four task categories: environment setup,
feature implementation (weather CLI), refactoring (modular architecture), and testing
(unit + integration). Validates actual code execution and file creation in a sandbox —
not just keyword matching. Registered in the suite registry as `openclaw_bench`.

## Run

```bash
# Direct — single task, execution mode (from this directory)
python eliza_adapter.py --task setup --mode execution

# Direct — all tasks, execution mode, JSON output
python eliza_adapter.py --all --mode execution --json --output-dir ./outputs

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks openclaw_bench --provider <p> --model <m>

# Docker-isolated sandbox
python eliza_adapter.py --all --mode execution --docker

# Via the inner openclaw module directly (bypasses eliza_adapter)
python -m openclaw.runner --all --output-dir ./outputs
```

Available tasks: `setup`, `implementation`, `testing`, `cli_arguments`, `error_handling` (execution mode); `refactoring` is conceptual-mode only.

API key required: `OPENAI_API_KEY` (recommended), `CEREBRAS_API_KEY`, or `GROQ_API_KEY`.
Model override: `--model <name>` or `BENCHMARK_MODEL_NAME` env var (default: `moonshotai/kimi-k2-instruct`).
Base URL override: `OPENAI_BASE_URL` (default: `https://api.groq.com/openai/v1`).

## Smoke test (no API keys)

```bash
# Conceptual mode: keyword-match only, no real code execution, no key required
python eliza_adapter.py --task setup --mode conceptual
```

Note: conceptual-mode scores are not publishable — the scorer in `registry/scores.py`
rejects them. Use this path for harness/import readiness checks only.

## Test the harness

```bash
# From the benchmarks/ suite root (no separate install needed)
pytest openclaw-benchmark/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `eliza_adapter.py` | CLI entrypoint; routes to execution or conceptual runner |
| `openclaw/runner.py` | Execution-mode runner (LLM + sandbox tool loop, up to 15 steps) |
| `openclaw/scoring.py` | Per-check scoring logic (file exists, command output, YAML valid, etc.) |
| `openclaw/sandbox.py` | `SandboxExecutor` — subprocess or Docker isolation |
| `openclaw/scenarios/` | YAML scenario definitions (prompt + scoring rubric per task) |
| `openclaw/validators.py` | Scoring check validators |
| `tests/test_scoring.py` | pytest suite for scoring correctness |
| `benchmark/standard_tasks.md` | Human-readable task specifications |

## Notes

- Results write to `outputs/` (default) or `--output-dir`; filename pattern `openclaw_<task>_exec_<timestamp>.json`.
- Scored by `_score_from_openclaw_bench_json` in `registry/scores.py`. Conceptual-mode results are rejected by the scorer.
- Scenarios run in dependency order when `--all` is used; a shared sandbox is passed between prerequisites so downstream tasks see files left by earlier ones.
- Full background: [README.md](README.md).
