# Mind2Web — Agent Guide

Web agent benchmark based on [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web).
Evaluates elizaOS agents on real-world web navigation and interaction tasks using the two-stage
MindAct pipeline (DeBERTa-v3 candidate ranker → LLM action predictor). Registered as `mind2web`.

## Run

```bash
# Direct, from packages/benchmarks/ (sample tasks, auto-detect provider from env)
PYTHONPATH=packages python -m benchmarks.mind2web --sample --provider groq --model openai/gpt-oss-120b

# Full benchmark from HuggingFace (requires datasets package)
PYTHONPATH=packages python -m benchmarks.mind2web --hf --max-tasks 50 --split test_task

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks mind2web --provider <p> --model <m>
```

## Smoke test (no API key)

```bash
# Oracle replay: deterministic ground-truth answer; scores 100% by design — CI only
PYTHONPATH=packages python -m benchmarks.mind2web --sample --mock
```

## Test the harness

```bash
# One-time install (from this directory)
pip install -e ".[dev]"

pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint (`python -m benchmarks.mind2web`) |
| `runner.py` | Benchmark orchestration loop |
| `eliza_agent.py` | elizaOS agent with `MIND2WEB_ACTION` action |
| `ranker.py` | MindAct stage-1 DeBERTa-v3 candidate ranker |
| `dataset.py` | Dataset loader (HuggingFace + local sample + fixtures) |
| `evaluator.py` | Step and task evaluation logic |
| `types.py` | Type definitions (`Mind2WebConfig`, `Mind2WebSplit`, etc.) |
| `tests/` | pytest suite (dataset, ranker, integration) |
| `tests/fixtures/mind2web_sample.pkl` | Bundled sample task fixture |

## Notes

- Results write to `./benchmark_results/mind2web/<timestamp>/` (gitignored).
- Result file pattern: `mind2web-results*.json`; located by `_mind2web_result` in `registry/commands.py`.
- Scored by `_score_from_mind2web_json` in `registry/scores.py`.
- Stage-1 ranker modes: `real` (DeBERTa-v3, ~750MB download, leaderboard-comparable),
  `oracle` (upper bound only — leaks GT), `none` (no filtering, diagnostic).
- `--mock` uses `OracleMind2WebAgent` (ground-truth replay, CI smoke tests only).
- Full background: [README.md](README.md).
