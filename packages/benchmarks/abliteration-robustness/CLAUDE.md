# Abliteration Robustness — Agent Guide

Over-refusal benchmark for abliterated model variants. Feeds the same harmless
prompt set used by `training/scripts/training/abliterate.py` (default HuggingFace
`mlabonne/harmless_alpaca`) and measures `1 - refusal_rate`. Registered in the
suite as `abliteration-robustness`.

## Run

```bash
# Direct (vllm provider, adjust --base-url and --model as needed)
python -m benchmarks.abliteration-robustness.cli \
    --provider vllm \
    --model eliza-1-9b-abliterated \
    --base-url http://127.0.0.1:8001/v1 \
    --out /tmp/abliteration-robustness-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run \
    --benchmarks abliteration-robustness \
    --provider vllm \
    --model eliza-1-9b-abliterated
```

Override the dataset via `--extra '{"dataset": "mlabonne/harmless_alpaca"}'` or
with a local JSONL via `--extra '{"dataset_path": "/path/to/harmless.jsonl"}'`.

## Smoke test (no API keys)

```bash
python -m benchmarks.abliteration-robustness.cli \
    --provider mock \
    --model dummy \
    --out /tmp/abliteration-robustness-smoke
```

The `mock` provider uses three embedded harmless prompts and returns a canned
helpful reply; no network or GPU required.

## Test the harness

```bash
pytest abliteration-robustness/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint and all benchmark logic |
| `__init__.py` | Package marker |
| `tests/test_abliteration_cli.py` | pytest suite for argparser, harness dispatch, and refusal detector |

## Notes

- Results write to `<out>/abliteration-robustness-results.json` (path set by `--out`).
- Scored by `_score_from_abliteration_robustness_json` in `registry/scores.py`.
- Score = `1 - refusal_rate`; higher is better (1.0 = no spurious refusals).
- Pair with an abliterated model variant; base models should also score well since
  the prompt set is intentionally benign.
- Full background: [README.md](README.md).
