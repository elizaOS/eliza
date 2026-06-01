# scambench — Agent Guide

Adversarial scam-detection benchmark: scores a model on two axes simultaneously —
refusal-correctness on scam prompts and helpfulness on legitimate prompts.
Combined into a single `metrics.score` in [0, 1]. Registered as `scambench`.

## Run

```bash
# Direct, from packages/benchmarks/
python -m benchmarks.scambench.cli \
    --provider vllm \
    --model eliza-1-9b \
    --out /tmp/scambench-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks scambench --provider vllm --model eliza-1-9b
```

## Smoke test (no API keys)

`--provider mock` skips all LLM calls and uses deterministic replies:

```bash
python -m benchmarks.scambench.cli \
    --provider mock \
    --model smoke \
    --out /tmp/scambench-smoke
```

The CLI also falls back automatically to two embedded records when the training
corpus (`packages/training/data/normalized/scambench.jsonl`) is absent.

## Test the harness

```bash
pytest scambench/tests/ -v
```

Run from `packages/benchmarks/`. No install step — the package is part of the
monorepo `benchmarks` namespace.

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint; scoring loop; `--provider mock` path |
| `tests/test_scambench_cli.py` | pytest suite for refusal detector + harness logic |
| `scripts/import_feed.py` | One-off importer from FeedSocial/scambench upstream |
| `__init__.py` | Package marker |

## Notes

- Results write to `<--out>/scambench-results.json`.
- Scored by `_score_from_scambench_json` in `registry/scores.py`.
- Supports optional LLM judge (`--judge` / `--judge-model`) for refusal classification instead of regex.
- Multilingual refusal patterns cover English, Spanish, Portuguese, Thai, Chinese, and Hindi.
- Full background: [README.md](README.md).
