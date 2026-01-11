# elizaos-plugin-evm (Rust)

Rust implementation of the EVM blockchain plugin for elizaOS.

## Features

- **Wallet Management**: Local key management using alloy-rs
- **Token Transfers**: Native and ERC20 token transfers
- **Token Swaps**: DEX aggregator integration via LiFi API
- **Cross-Chain Bridges**: Cross-chain transfers via LiFi API
- **Strong Types**: Compile-time safety with zero-cost abstractions

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-evm = "2.0"
```

## Quick Start

```rust
use elizaos_plugin_evm::{
    WalletProvider, WalletProviderConfig, TransferAction, TransferParams,
    SupportedChain,
};
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create wallet provider
    let config = WalletProviderConfig::new("0x...")  // your private key
        .with_chain(SupportedChain::Mainnet, None)
        .with_chain(SupportedChain::Base, None);

    let provider = Arc::new(WalletProvider::new(config).await?);

    // Check balance
    let balance = provider.get_formatted_balance(SupportedChain::Mainnet).await?;
    println!("Balance: {} ETH", balance);

    // Execute transfer
    let transfer = TransferAction::new(provider);
    let params = TransferParams::native(
        SupportedChain::Mainnet,
        "0x...".parse()?,  // recipient
        "0.1",
    );

    let tx = transfer.execute(params).await?;
    println!("Transaction: {:?}", tx.hash);

    Ok(())
}
```

## Supported Chains

- Ethereum Mainnet
- Sepolia (Testnet)
- Base
- Base Sepolia (Testnet)
- Arbitrum One
- Optimism
- Polygon
- Avalanche C-Chain
- BNB Smart Chain
- And more...

## Actions

### Transfer

Transfer native tokens or ERC20 tokens:

```rust
// Native transfer
let params = TransferParams::native(chain, recipient, "1.0");
let tx = transfer.execute(params).await?;

// ERC20 transfer
let params = TransferParams::erc20(chain, recipient, token_address, "100.0");
let tx = transfer.execute_erc20(params).await?;
```

### Swap

Swap tokens using DEX aggregators:

```rust
let swap = SwapAction::new(provider);
let params = SwapParams::new(
    SupportedChain::Mainnet,
    weth_address,
    usdc_address,
    "1.0",
);

// Get quote first
let quote = swap.get_quote(&params).await?;
println!("Min output: {}", quote.min_output_amount);

// Execute swap
let tx = swap.execute(params).await?;
```

### Bridge

Bridge tokens across chains:

```rust
let bridge = BridgeAction::new(provider);
let params = BridgeParams::new(
    SupportedChain::Mainnet,
    SupportedChain::Base,
    eth_address,
    eth_address,
    "0.5",
);

let (tx, status) = bridge.execute(params).await?;
println!("Bridge status: {:?}", status.status);
```

## Error Handling

All errors are strongly typed with `EVMError`:

```rust
match transfer.execute(params).await {
    Ok(tx) => println!("Success: {:?}", tx.hash),
    Err(EVMError { code: EVMErrorCode::InsufficientFunds, .. }) => {
        println!("Not enough funds!");
    }
    Err(e) => println!("Error: {}", e),
}
```

## Testing

Run unit tests:

```bash
cargo test
```

Run integration tests (requires funded testnet wallet):

```bash
export TEST_PRIVATE_KEY="0x..."
export SEPOLIA_RPC_URL="https://..."
cargo test --test integration_tests -- --ignored
```

## Building

Native build:

```bash
cargo build --release
```

WASM build (for browser):

```bash
cargo build --release --target wasm32-unknown-unknown --features wasm
```

## License

MIT
