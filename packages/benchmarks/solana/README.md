# Solana-Gym Benchmark

Evaluates an AI agent's ability to discover Solana on-chain instructions by
constructing and submitting unsigned transactions against a Surfpool sandbox.
The agent works through 8 Solana programs (System, Token, Token-2022, Memo,
Compute Budget, Stake, ATA, Address Lookup Table) and tries to discover all 236
unique program/discriminator pairs. Score is `discovered / 236`.

## Quick Start

```bash
# One-time setup (installs Python + Bun deps, checks for surfpool)
bash setup.sh

# Run with external Surfpool (start surfpool first)
surfpool start -u https://api.mainnet-beta.solana.com --no-tui &
USE_EXTERNAL_SURFPOOL=true \
  ENVIRONMENT_CONFIG=voyager/environments/basic_env.json \
  MODEL_NAME=anthropic/claude-sonnet-4.6 \
  python -m benchmarks.solana.eliza_explorer

# Via orchestrator
python -m benchmarks.orchestrator run --benchmarks solana --provider cerebras --model gpt-oss-120b
```

See [AGENTS.md](AGENTS.md) for full env-var reference, harness options, and test commands.
The upstream gym environment lives in [solana-gym-env/](solana-gym-env/) with its own
[README](solana-gym-env/README.md).
