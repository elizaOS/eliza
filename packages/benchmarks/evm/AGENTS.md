# EVM Onchain Benchmark — Agent Guide

EVM onchain agent benchmark: measures how many unique `(contract_address, function_selector)` pairs an
agent can discover on an EVM chain. Two-phase — deterministic viem templates first, then LLM-assisted
exploration. Supports Anvil (local), Hyperliquid EVM, and any EVM-compatible RPC. Not registered in
the suite orchestrator registry.

## Run

```bash
# From packages/benchmarks/ — local Anvil node (auto-spawned):
python -m benchmarks.evm.eliza_explorer

# With an already-running external node (Anvil or otherwise):
USE_EXTERNAL_NODE=true python -m benchmarks.evm.eliza_explorer

# Hyperliquid EVM testnet:
CHAIN=hyperliquid CHAIN_ID=998 USE_EXTERNAL_NODE=true \
  RPC_URL=https://api.hyperliquid-testnet.xyz/evm \
  AGENT_PRIVATE_KEY=<key> \
  python -m benchmarks.evm.eliza_explorer
```

Key env vars:

| Variable | Default | Notes |
| --- | --- | --- |
| `MODEL_NAME` | `openai/gpt-oss-120b` | Prefix with `groq/`, `anthropic/`, `openrouter/`, etc. |
| `MAX_MESSAGES` | `50` | Total steps per run |
| `CHAIN` | `general` | `general` or `hyperliquid` |
| `RPC_URL` | `http://127.0.0.1:8545` | EVM node RPC endpoint |
| `CHAIN_ID` | `31337` | `31337` for Anvil, `998` for HL testnet |
| `USE_EXTERNAL_NODE` | `false` | Skip auto-spawning Anvil |
| `FORK_URL` | _(empty)_ | Optional mainnet fork URL |
| `AGENT_PRIVATE_KEY` | Anvil account #0 | Only needed with a real key |

## Setup

One-time dependency install:

```bash
bash packages/benchmarks/evm/setup.sh
```

This installs Python deps (`aiohttp`, `langchain`, `python-dotenv`), runs `bun install` in
`skill_runner/` (installs `viem`), and creates a default `.env`.

Requires: Python 3.12+, Bun, and Foundry's `anvil` (for local mode).

## Test the harness

```bash
# From packages/benchmarks/ (no API keys needed — no network calls):
pytest benchmarks/evm/test_evm_benchmark.py -v
```

The Bun typecheck tests (`TestTemplatesBunTypeCheck`) are skipped automatically if `bun` is not on
PATH or `skill_runner/node_modules/` is not present.

## Layout

| Path | Role |
| --- | --- |
| `eliza_explorer.py` | Main CLI entrypoint (`python -m benchmarks.evm.eliza_explorer`) |
| `anvil_env.py` | Gymnasium-style EVM env; manages Anvil lifecycle + reward calculation |
| `exploration_strategy.py` | Two-phase strategy: deterministic templates → LLM-assisted |
| `contract_catalog.py` | Catalog of EVM contracts + function selectors scored as targets |
| `skill_templates.py` | Pre-built viem TypeScript templates for Phase 1 |
| `providers.py` | LLM provider detection and API key routing |
| `skill_runner/` | Bun/TypeScript runner that executes skill code against the chain |
| `skill_runner/runSkill.ts` | Entry point for Bun skill execution |
| `skill_runner/evm_skill.ts` | Default skill code file (overwritten each step) |
| `environments/` | Environment config JSONs (`general_env.json`, `hyperliquid_env.json`, `defi_env.json`) |
| `contracts/` | Solidity source for deployed benchmark contracts |
| `metrics/` | Run output written here (gitignored) |
| `test_evm_benchmark.py` | pytest suite — covers catalog, templates, strategy, env, and explorer |

## Notes

- Results write to `evm/metrics/<run_id>_metrics.json` (and `_conversation.json` for LLM runs).
  The `metrics/` directory is gitignored; do not commit run outputs.
- Not registered in `registry/commands.py`; no orchestrator `--benchmarks` id.
- The `METRICS_DIR` env var overrides the output directory.
- Full README: [README.md](README.md).
