# WooBench

Mystical reading conversation and revenue benchmark for elizaOS agents.

WooBench drives an agent through tarot, I Ching, and astrology reading scenarios
using 10 simulated user persona archetypes — from true believers to skeptics,
emotional-crisis users, and active scammers. It measures reading quality,
persona engagement depth, payment conversion behaviour, crisis handling, and
scam resistance, aggregating results into a single `WooScore` (0–100) alongside
a detailed revenue report.

## Quick Start

```bash
# Full run against the default eliza TS bridge
python -m benchmarks.woobench --model gpt-5 --output benchmark_results/

# Smoke test — no API keys required
python -m benchmarks.woobench --agent dummy --evaluator heuristic --model dummy

# List all available scenarios
python -m benchmarks.woobench --list-scenarios
```

See [AGENTS.md](AGENTS.md) for the complete option reference, orchestrator
invocation, and test instructions.
