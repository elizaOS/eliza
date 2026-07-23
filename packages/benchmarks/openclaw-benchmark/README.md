# OpenClaw-Bench

AI coding-assistant benchmark: the agent completes standardized software tasks —
environment setup, feature implementation (a weather CLI), refactoring into a
modular architecture, and testing (unit + integration) — inside a sandboxed
workspace. Scoring validates real outcomes (files created, commands executed,
output correctness), not keyword matching. Registered in the suite registry as
`openclaw_bench`.

## What it measures

Each task is a YAML scenario (`openclaw/scenarios/`) with a prompt and a scoring
rubric. In **execution mode** the runner (`openclaw/runner.py`) drives an LLM
tool loop (up to 15 steps) against a `SandboxExecutor` — subprocess isolation by
default, Docker with `--docker` — and `openclaw/scoring.py` checks the concrete
results: does the file exist, does the command run, is the YAML valid.
**Conceptual mode** is a no-key keyword-match smoke path; its scores are not
publishable and `registry/scores.py` rejects them.

Tasks run in dependency order under `--all`, sharing one sandbox so downstream
tasks see files left by earlier ones. Human-readable task specifications live in
[`benchmark/standard_tasks.md`](benchmark/standard_tasks.md).

## Quick start

```bash
# Direct — single task, execution mode (needs an API key)
python eliza_adapter.py --task setup --mode execution

# No-key smoke (conceptual mode, harness/import readiness only)
python eliza_adapter.py --task setup --mode conceptual

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks openclaw_bench --provider <p> --model <m>
```

## Integration

- Registry command builder: `_openclaw_bench_cmd` in `registry/commands.py` —
  invokes `eliza_adapter.py` and defaults to execution mode; `provider=mock`
  routes to conceptual mode for readiness checks.
- Scored by `_score_from_openclaw_bench_json` in `registry/scores.py`; results
  land in the orchestrator output dir as `openclaw_<task>_exec_<timestamp>.json`.

See [AGENTS.md](AGENTS.md) for the full task list, model/env configuration,
smoke paths, and test commands.
