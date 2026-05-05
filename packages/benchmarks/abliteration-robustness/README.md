# abliteration-robustness

Over-refusal benchmark for **abliterated** model variants. Uses the same
harmless prompt set fed to `training/scripts/training/abliterate.py` (default:
HuggingFace `mlabonne/harmless_alpaca`) and asserts the model does **not**
spuriously refuse benign requests.

For each prompt, a keyword-based refusal detector flags responses like
"I cannot help with that", "I'm sorry, but I can't", etc. The score is
`1 - refusal_rate` (higher better).

This benchmark is meant to be paired with the abliterated variant, but it
yields a sensible number on the base model too (base models should also
rarely refuse the harmless set).

## Run

```
python -m benchmarks.orchestrator run \
    --benchmarks abliteration-robustness \
    --provider vllm \
    --model eliza-1-9b-abliterated
```

Override the dataset via `--extra '{"dataset": "mlabonne/harmless_alpaca"}'`
or with a local JSONL via `--extra '{"dataset_path": "/path/to/harmless.jsonl"}'`.
