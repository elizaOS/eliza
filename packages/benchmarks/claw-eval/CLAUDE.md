# Claw-Eval — Agent Guide

300-task autonomous-agent benchmark from PKU/HKU (arXiv 2604.06132). Evaluates agents across
9 categories (communication, finance, ops, productivity, multimodal generation, document
extraction, video QA, multi-turn dialog) on three dimensions: **Completion**, **Safety**, and
**Robustness**. Primary metric is **Pass^3** — a task only counts as passed if all 3 independent
trials clear the 0.75 threshold. Not registered in the suite orchestrator registry; run directly
via the `claw-eval` CLI installed from this package.

## Run

```bash
# Install (from this directory)
pip install -e ".[mock,sandbox]"

# Single task (local mode, no Docker)
claw-eval run --task tasks/T001zh_email_triage --config config_general.yaml

# Full batch — general split (161 tasks, 3 trials each, Docker sandbox required)
claw-eval batch --config config_general.yaml --sandbox --trials 3 --parallel 16

# Full batch — multimodal split
claw-eval batch --config config_multimodal.yaml --sandbox --trials 3 --parallel 16

# Full batch — multi-turn/user-agent split
claw-eval batch --config config_user_agent.yaml --sandbox --trials 3 --parallel 16

# Grade an existing trace without re-running
claw-eval grade --trace traces/<model_date>/T001zh_email_triage_<ts>.jsonl \
    --task tasks/T001zh_email_triage --config config_general.yaml

# Aggregate scores from a completed trace directory
python score_summary.py traces/
```

## Smoke test (no API keys)

There is no built-in `--mock` flag. To validate the task schema and sandbox stack without
running a full model evaluation:

```bash
# Validate all task YAMLs
python scripts/validate_tasks.py

# Bring up the sandbox stack and confirm connectivity
bash scripts/test_sandbox.sh
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest src/ -v
```

No test files are present in this checkout (vendored upstream; pytest will collect 0 items).
The validate_tasks script is the best quick-check for harness correctness.

## Layout

| Path | Role |
| --- | --- |
| `src/claw_eval/cli.py` | CLI entrypoint (`claw-eval` command — run / batch / grade / list / build-image / cleanup) |
| `src/claw_eval/runner/loop.py` | Agent execution loop |
| `src/claw_eval/graders/` | Per-category grader modules (LLM judge, image QA, multimodal, office QA, pinbench) |
| `src/claw_eval/runner/services.py` | Mock service manager (starts/stops per-task local HTTP stubs) |
| `src/claw_eval/runner/sandbox_runner.py` | Docker sandbox lifecycle |
| `mock_services/` | FastAPI servers for 15+ mocked SaaS endpoints (gmail, calendar, contacts, finance, etc.) |
| `tasks/` | 300 task directories, each with `task.yaml` + `grader.py` |
| `config_general.yaml` | Runner config for the general split (161 tasks); default model `anthropic/claude-opus-4.6` via OpenRouter, judge `google/gemini-3-flash-preview` |
| `config_multimodal.yaml` | Runner config for the multimodal split (101 tasks) |
| `config_user_agent.yaml` | Runner config for the multi-turn split (38 tasks); uses Claude for both agent and judge |
| `score_summary.py` | Post-hoc aggregator — computes Pass@1 mean and Pass^3 from a traces directory |
| `Dockerfile.agent` | Sandbox container image (per-task isolated environment with mocked endpoints) |
| `scripts/test_sandbox.sh` | One-time sandbox stack smoke test |
| `INTEGRATION.md` | Working notes on wiring into the suite orchestrator |

## Notes

- Requires `OPENROUTER_API_KEY` (and `SERP_DEV_KEY` for tasks that use live web search).
- Docker must be available for `--sandbox` mode; each task spins an isolated container.
- Traces write to `traces/<model>_<YYYY-MM-DD-HH-MM>/` (relative to cwd). Batch results
  land in `traces/<model_date>/batch_results.json` and `batch_summary.json`.
- Pass threshold: `task_score >= 0.75`. Pass^3: all 3 trials must clear it.
- Video fixtures are not bundled here due to size; fetch from
  [HuggingFace claw-eval/Claw-Eval](https://huggingface.co/datasets/claw-eval/Claw-Eval).
- Not yet wired into the suite registry. See `INTEGRATION.md` §8 for the planned adapter.
- Full background: [README.md](README.md).
