# EVM Onchain Benchmark

EVM onchain agent benchmark for elizaOS. Evaluates an agent's ability to discover unique
`(contract_address, function_selector)` pairs across an EVM chain. Runs in two phases: first,
deterministic viem/TypeScript templates that exercise standard contracts and EVM precompiles; then,
LLM-assisted exploration guided by a contract catalog covering ERC-20s, ERC-721s, Hyperliquid system
contracts, and more. Works with a local Anvil node (auto-spawned) or any external EVM-compatible RPC
(Hyperliquid EVM testnet, mainnet fork via `FORK_URL`, etc.).

## Quick Start

```bash
# One-time setup (installs Python deps + Bun deps for skill_runner/)
bash packages/benchmarks/evm/setup.sh

# Run with local Anvil (spawned automatically):
python -m benchmarks.evm.eliza_explorer

# Run with external node (no Anvil required):
USE_EXTERNAL_NODE=true python -m benchmarks.evm.eliza_explorer

# Run harness tests (no API keys needed):
pytest benchmarks/evm/test_evm_benchmark.py -v
```

See [AGENTS.md](AGENTS.md) for all environment variables, chain configs, and layout details.
