# @elizaos/plugin-evm

Multi-language EVM blockchain plugin for elizaOS with TypeScript, Rust, and Python implementations.

## Overview

This plugin provides comprehensive functionality for interacting with EVM-compatible blockchains, including token transfers, cross-chain bridging, and token swaps using LiFi integration. The plugin is available in three languages:

| Language   | Package                          | Status        |
| ---------- | -------------------------------- | ------------- |
| TypeScript | `@elizaos/plugin-evm`            | ✅ Production |
| Rust       | `elizaos-plugin-evm` (crates.io) | ✅ Production |
| Python     | `elizaos-plugin-evm` (PyPI)      | ✅ Production |

## Features

- **Multi-chain Support**: Ethereum, Base, Arbitrum, Optimism, Polygon, and 10+ more chains
- **Native Token Transfers**: Send ETH, MATIC, BNB, etc.
- **ERC20 Token Transfers**: Send any ERC20 token
- **Cross-chain Bridging**: Bridge tokens between chains via LiFi
- **Token Swaps**: Exchange tokens on supported DEXs
- **DAO Governance**: Propose, vote, queue, and execute proposals
- **Strong Typing**: Branded types with Zod (TS), Pydantic (Python), and strongly-typed structs (Rust)
- **Fail-Fast Validation**: No defensive programming - invalid data fails immediately

## Supported Chains

| Chain             | ID       | Native Token |
| ----------------- | -------- | ------------ |
| Ethereum Mainnet  | 1        | ETH          |
| Sepolia (testnet) | 11155111 | ETH          |
| Base              | 8453     | ETH          |
| Base Sepolia      | 84532    | ETH          |
| Arbitrum One      | 42161    | ETH          |
| Optimism          | 10       | ETH          |
| Polygon           | 137      | MATIC        |
| Avalanche C-Chain | 43114    | AVAX         |
| BNB Smart Chain   | 56       | BNB          |
| Gnosis            | 100      | xDAI         |
| Fantom            | 250      | FTM          |
| Linea             | 59144    | ETH          |
| Scroll            | 534352   | ETH          |
| zkSync Era        | 324      | ETH          |

## Installation

### TypeScript

```bash
bun add @elizaos/plugin-evm
# or
npm install @elizaos/plugin-evm
```

### Rust

```toml
[dependencies]
elizaos-plugin-evm = "0.1"
```

### Python

```bash
pip install elizaos-plugin-evm
```

## Quick Start

### TypeScript

```typescript
import { evmPlugin, EvmService } from "@elizaos/plugin-evm";

// Add to your agent
const agent = createAgent({
  plugins: [evmPlugin],
});

// Or use the service directly
const service = new EvmService();
await service.initialize(runtime);

// Get wallet info
const address = service.getAddress();
const balance = await service.getBalance("mainnet");
```

### Rust

```rust
use elizaos_plugin_evm::{EVMAdapterImpl, EVMAdapter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let agent_id = UUID::new_v4();
    let private_key = std::env::var("EVM_PRIVATE_KEY")?;

    let adapter = EVMAdapterImpl::new(&agent_id, &private_key).await?;
    adapter.init().await?;

    let address = adapter.get_address().await?;
    println!("Address: {:?}", address);

    Ok(())
}
```

### Python

```python
import asyncio
from elizaos_plugin_evm import EVMWalletProvider, SupportedChain

async def main():
    provider = EVMWalletProvider("your_private_key")
    print(f"Address: {provider.address}")

    balance = await provider.get_balance(SupportedChain.MAINNET)
    print(f"Balance: {balance.native_balance} ETH")

asyncio.run(main())
```

## Configuration

### Environment Variables

```env
# Required
EVM_PRIVATE_KEY=your-private-key-here

# Optional - Custom RPC URLs
EVM_PROVIDER_URL=https://your-custom-mainnet-rpc-url
ETHEREUM_PROVIDER_BASE=https://mainnet.base.org
ETHEREUM_PROVIDER_ARBITRUM=https://arb1.arbitrum.io/rpc
```

### Character Configuration

```json
{
  "settings": {
    "chains": {
      "evm": ["base", "arbitrum", "optimism"]
    }
  }
}
```

## Actions

### Transfer

Transfer native tokens or ERC20 tokens:

```typescript
// TypeScript
Transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e on mainnet
Transfer 100 USDC to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e on base
```

```python
# Python
from elizaos_plugin_evm import TransferParams, execute_transfer

params = TransferParams(
    from_chain=SupportedChain.MAINNET,
    to_address="0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amount="1.0",
)
tx_hash = await execute_transfer(provider, params)
```

### Swap

Swap tokens on the same chain:

```typescript
// TypeScript
Swap 1 ETH for USDC on Base
```

```python
# Python
from elizaos_plugin_evm import SwapParams, execute_swap

params = SwapParams(
    chain=SupportedChain.MAINNET,
    from_token="0x0000000000000000000000000000000000000000",  # ETH
    to_token="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",  # USDC
    amount="1000000000000000000",
    slippage=0.01,
)
tx_hash = await execute_swap(provider, params)
```

### Bridge

Bridge tokens between chains:

```typescript
// TypeScript
Bridge 1 ETH from Ethereum to Base
```

```python
# Python
from elizaos_plugin_evm import BridgeParams, execute_bridge

params = BridgeParams(
    from_chain=SupportedChain.MAINNET,
    to_chain=SupportedChain.BASE,
    from_token="0x0000000000000000000000000000000000000000",
    to_token="0x0000000000000000000000000000000000000000",
    amount="1000000000000000000",
)
status = await execute_bridge(provider, params)
```

### DAO Governance

```typescript
// Propose
Propose a proposal to the 0xGOVERNOR governor on Ethereum to transfer 1 ETH to 0xRecipient

// Vote
Vote FOR on proposal 1 on the 0xGOVERNOR governor on Ethereum

// Queue
Queue proposal 1 on the 0xGOVERNOR governor on Ethereum

// Execute
Execute proposal 1 on the 0xGOVERNOR governor on Ethereum
```

## Type Safety

All implementations enforce strong types with fail-fast validation:

### TypeScript (Zod + Branded Types)

```typescript
import { ZAddress, ZTransferParams } from "@elizaos/plugin-evm";

// Validated at runtime
const address = ZAddress.parse("0x1234..."); // Throws if invalid
const params = ZTransferParams.parse({
  fromChain: "mainnet",
  toAddress: "0x...",
  amount: "1.0",
});
```

### Python (Pydantic)

```python
from elizaos_plugin_evm import TransferParams
from pydantic import ValidationError

try:
    params = TransferParams(
        from_chain=SupportedChain.MAINNET,
        to_address="invalid",  # Fails!
        amount="0",  # Fails!
    )
except ValidationError as e:
    print(e)
```

### Rust (Type System)

```rust
use elizaos_plugin_evm::types::{Address, TransferParams};

// Compile-time type safety
let address: Address = "0x1234...".parse()?;
let params = TransferParams::new(
    ChainName::Mainnet,
    address,
    "1.0".into(),
)?;
```

## Directory Structure

```
packages/plugin-evm/
├── typescript/           # TypeScript implementation
│   ├── actions/          # Transfer, swap, bridge actions
│   ├── providers/        # Wallet provider
│   ├── types/            # Branded types and Zod schemas
│   └── index.ts          # Main entry point
├── rust/                 # Rust implementation
│   ├── src/
│   │   ├── actions/      # Transfer, swap, bridge actions
│   │   ├── providers/    # Wallet adapter
│   │   ├── types.rs      # Type definitions
│   │   └── lib.rs        # Main entry point
│   ├── tests/            # Integration tests
│   └── Cargo.toml        # Crate manifest
├── python/               # Python implementation
│   ├── elizaos_plugin_evm/
│   │   ├── actions/      # Transfer, swap, bridge actions
│   │   ├── providers/    # Wallet provider
│   │   ├── types.py      # Pydantic models
│   │   └── __init__.py   # Main entry point
│   ├── tests/            # Integration tests
│   └── pyproject.toml    # Package manifest
├── build.ts              # Build script
├── package.json          # NPM manifest
└── README.md             # This file
```

## Development

### Building

```bash
# TypeScript
bun run build

# Rust (native)
cd rust && cargo build --release

# Rust (WASM)
cd rust && cargo build --release --target wasm32-unknown-unknown --features wasm

# Python
cd python && pip install -e ".[dev]"
```

### Testing

```bash
# TypeScript
npx vitest

# Rust
cd rust && cargo test

# Python
cd python && pytest tests/ -v
```

### Integration Tests

All implementations include integration tests against live testnets:

```bash
# Set your testnet private key
export EVM_PRIVATE_KEY="your_testnet_private_key"

# TypeScript
bun run test:integration

# Rust
cd rust && cargo test --features native -- --ignored

# Python
cd python && pytest tests/test_integration.py -v
```

## Publishing

### TypeScript (npm)

```bash
bun run build
npm publish
```

### Rust (crates.io)

```bash
cd rust
cargo publish
```

### Python (PyPI)

```bash
cd python
python -m build
twine upload dist/*
```

## API Reference

See language-specific READMEs for detailed API documentation:

- [TypeScript API](typescript/README.md)
- [Rust API](rust/README.md)
- [Python API](python/README.md)

## Credits

This plugin integrates with:

- [Ethereum](https://ethereum.org/): Decentralized blockchain
- [LiFi](https://li.quest/): Cross-chain bridge and swap aggregator
- [viem](https://viem.sh/): TypeScript Ethereum client
- [alloy-rs](https://github.com/alloy-rs/alloy): Rust Ethereum toolkit
- [web3.py](https://web3py.readthedocs.io/): Python Ethereum library

## License

MIT - See [LICENSE](LICENSE) for details.
