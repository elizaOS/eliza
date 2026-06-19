# Social-Alpha Benchmark

Trust marketplace benchmark that evaluates AI systems on their ability to extract
trading signals, rank traders by reliability, detect scam tokens and bad actors,
and simulate profit outcomes — all on real Discord crypto-chat data from the
ElizaOS Trenches community (267k messages, Oct 2024 – Jan 2025). The four scored
suites (EXTRACT / RANK / DETECT / PROFIT) combine into a composite Trust
Marketplace Score (TMS). Registered in the elizaOS benchmark suite as `social_alpha`.

## Quick Start

```bash
# Install (from this directory)
pip install -e ".[dev]"

# Smoke run — no keys, no dataset download required
python -m benchmark.harness --data-dir fixtures/smoke-data --system baseline

# Full run with the Trenches Chat dataset + an LLM backend
python -m benchmark.harness --data-dir trenches-chat-dataset/data --system full \
    --model groq/llama-3.3-70b-versatile

# Via the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks social_alpha --provider groq --model llama-3.3-70b-versatile
```

See [AGENTS.md](AGENTS.md) for all options, system choices, and how to run the test suite.
