# Standard Academic Benchmarks

Self-contained adapters for four widely-used academic benchmarks — MMLU, HumanEval,
GSM8K, and MT-Bench — each speaking directly to any OpenAI-compatible inference
endpoint. Adapters share a common CLI scaffolding (`_cli.py`, `_base.py`) and are
registered in the elizaOS benchmark suite registry as `mmlu`, `humaneval`, `gsm8k`,
and `mt_bench`.

## Quick Start

```bash
# Run one benchmark directly (requires API key in env)
python -m benchmarks.standard.mmlu \
    --provider openai --model gpt-4o-mini --output /tmp/mmlu-out

# Offline smoke test — no API key needed
python -m benchmarks.standard.mmlu --mock --provider openai --model mock \
    --output /tmp/mmlu-smoke --api-key-env DOES_NOT_EXIST

# Via the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks mmlu --provider openai --model gpt-4o-mini
```

See [AGENTS.md](AGENTS.md) for all four adapters' commands, mock invocations, and the
test suite.
