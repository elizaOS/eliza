# Vending-Bench

elizaOS reimplementation of Andon Labs' [Vending-Bench](https://arxiv.org/abs/2502.15840): a
long-horizon coherence benchmark that runs an LLM agent as the operator of a simulated vending
machine business over up to 30 days. The agent manages inventory ordering, pricing, and cash;
the headline score is net worth at end of run.

## Quick Start

```bash
# No API key — heuristic agent
python -m elizaos_vending_bench.cli run --provider heuristic --runs 1 --days 3 --starter-inventory

# OpenAI
python -m elizaos_vending_bench.cli run --provider openai --model gpt-4o --runs 5 --days 30

# Via suite orchestrator
python -m benchmarks.orchestrator run --benchmarks vending_bench --provider openai --model gpt-4o
```

See [AGENTS.md](AGENTS.md) for full run options, test commands, and layout.
See [RESEARCH.md](RESEARCH.md) for paper background and implementation notes.
