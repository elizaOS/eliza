# NL2Repo-Bench — Agent Guide

Long-horizon, 0-to-1 repository generation benchmark (arXiv:2512.12730). An
agent receives a natural-language requirements document (`start.md`) and an
empty workspace, and must produce a fully installable, runnable Python library.
104 tasks scored by pytest pass-rate inside per-task Docker eval images. Not
registered in the suite orchestrator; run directly via `adapter_matrix.py`.

## Run

```bash
# From packages/benchmarks/nl2repo — requires Docker + NL2REPO_AGENT_COMMAND_TEMPLATE
pip install -r requirements.txt
python adapter_matrix.py \
  --task-agent elizaos \
  --model-provider cerebras \
  --model gpt-oss-120b \
  --output /tmp/nl2repo-out \
  --max-tasks 1

# Original OpenHands batch runner (requires openhands Docker images + config.json creds)
python main.py
```

## Smoke test (no Docker, no API keys)

```bash
python adapter_matrix.py \
  --task-agent elizaos \
  --model-provider cerebras \
  --model gpt-oss-120b \
  --output /tmp/nl2repo-mock \
  --max-tasks 5 \
  --mock
```

## Test the harness

```bash
pip install -r requirements.txt pytest
pytest packages/benchmarks/nl2repo/tests/test_adapter_matrix.py -v
```

## Layout

| Path | Role |
| --- | --- |
| `adapter_matrix.py` | Adapter-facing CLI and task/scoring harness (main entrypoint for elizaOS suite) |
| `main.py` | Original OpenHands batch runner (reference only) |
| `config.json` | Canonical 104-task list (`startPro[0].proNameList`) + concurrency settings |
| `test_files/<task>/` | Per-task fixtures: `start.md`, `test_commands.json`, `test_files.json`, `test_case_count.txt` |
| `test_files/task_difficulty.csv` | Easy/Medium/Hard labels for all 104 tasks |
| `openhands/post_processor.py` | Docker image build + pytest parse (scoring logic used by `adapter_matrix.py`) |
| `tests/test_adapter_matrix.py` | pytest suite for the adapter harness (no Docker needed) |
| `INTEGRATION.md` | Deep integration notes, dataset description, scoring formula, adapter wiring plan |

## Notes

- Results write to `--output <dir>/result.json` (not in git; gitignored by convention).
- Scoring: `score = passed / test_case_count` per task; aggregate = mean across all 104.
- Eval images: `ghcr.io/multimodal-art-projection/nl2repobench/<task>:1.0` (104 images, multi-GB; pulled lazily).
- Agent command is injected via `NL2REPO_AGENT_COMMAND_TEMPLATE` env var or `--agent-command-template`.
- `--no-docker` skips Docker post-processing (generation-only mode; scores are 0, not release-comparable).
- Dataset source and paper: [INTEGRATION.md](INTEGRATION.md). Upstream repo: [github.com/multimodal-art-projection/NL2RepoBench](https://github.com/multimodal-art-projection/NL2RepoBench).
