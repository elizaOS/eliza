# Mind2Web — Agent Guide

Web agent benchmark based on [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web).
Evaluates elizaOS agents on real-world web navigation and interaction tasks using the two-stage
MindAct pipeline (DeBERTa-v3 candidate ranker → LLM action predictor). Registered as `mind2web`.

## Run

```bash
# Explicit non-publishable smoke run
PYTHONPATH=suites python -m mind2web --sample --mock

# Validate a complete pinned test split without spending model quota
MIND2WEB_DISABLE_DATA_DOWNLOAD=1 PYTHONPATH=suites \
  python -m mind2web --hf --split test_task --count-scenarios \
  --expected-tasks 252

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.suites.orchestrator run --benchmarks mind2web --provider <p> --model <m>
```

## Smoke test (no API key)

```bash
# Oracle replay: deterministic ground-truth answer; scores 100% by design — CI only
PYTHONPATH=suites python -m mind2web --sample --mock
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
| `cli.py` | CLI entrypoint (`python -m mind2web`) |
| `runner.py` | Benchmark orchestration loop |
| `eliza_agent.py` | elizaOS agent with `MIND2WEB_ACTION` action |
| `ranker.py` | MindAct stage-1 DeBERTa-v3 candidate ranker |
| `dataset.py` | Checksum-pinned encrypted official test archive, explicit local data, and smoke fixtures |
| `evaluator.py` | Upstream-compatible exact element/action and macro task scoring |
| `types.py` | Type definitions (`Mind2WebConfig`, `Mind2WebSplit`, etc.) |
| `tests/` | pytest suite (dataset, ranker, integration) |
| `tests/fixtures/mind2web_sample.pkl` | Bundled sample task fixture |

## Notes

- Results write to `./benchmark_results/mind2web/<timestamp>/` (gitignored).
- Result file pattern: `mind2web-results*.json`; located by `_mind2web_result` in `registry/commands.py`.
- Scored by `_score_from_mind2web_json` in `registry/scores.py`.
- Full runs load the encrypted official `test.zip` at revision
  `17ece8eb89862368edc0cc806acee6fca5163474`, verify SHA-256
  `8f5fbe72afab942fe97cdf7fb397e179885d89b5c16862288e9a14bc6d41ca89`,
  and require exact split counts (252 / 177 / 912). Data or parse failures never
  fall back to samples or train data.
- Stage-1 `real` mode pins the released MindAct ranker revision
  `92d3ddcb079b1749015d72293c82d640b0b9a1da`; `oracle` leaks ground truth and
  `none` is diagnostic. Only `real` is accepted by production scoring.
- Full runs reuse OSU's released candidate-generation scores, pinned at
  SHA-256 `884c97cd9ae0544485d21ea39e0d46422aee0291969a7324e56df3a84466dbd7`,
  so all harnesses receive exactly the same top-50 and do not repeat a
  deterministic 630-candidates-per-step ranker workload.
- Eliza, Hermes, and OpenClaw all receive the same pruned-DOM action surface,
  ranked top-50 candidates, prior actions, required action schema, and no
  current/future annotated action. Invalid output remains an invalid prediction.
- Cohort results use the official corpus, ranker, and macro scoring contract,
  but the Claude action protocol and derived edge variants are not claimed as
  published MindAct leaderboard entries.
- `--mock` uses `OracleMind2WebAgent` (ground-truth replay, CI smoke tests only).
- Full background: [README.md](README.md).

