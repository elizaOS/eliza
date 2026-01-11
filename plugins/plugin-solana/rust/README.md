# elizaOS Plugin Solana (Rust)

Rust implementation of the Solana blockchain plugin for elizaOS agents.

## Features

- **Wallet Management**: Keypair generation, validation, and key derivation
- **SOL & SPL Token Transfers**: Send SOL and SPL tokens with full signing support
- **Token Swaps via Jupiter**: Get quotes and execute swaps using Jupiter aggregator
- **Balance Queries**: Query balances for multiple addresses efficiently
- **Price Data**: Fetch token prices via Birdeye API

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-solana = "1.2.6"
```

## Quick Start

```rust
use elizaos_plugin_solana::{SolanaClient, WalletConfig};
use rust_decimal::Decimal;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Read-only mode
    let config = WalletConfig::read_only(
        "https://api.mainnet-beta.solana.com".to_string(),
        "YourPublicKeyHere",
    )?;

    let client = SolanaClient::new(config)?;

    // Get balance
    let balance = client.get_sol_balance().await?;
    println!("Balance: {} SOL", balance);

    Ok(())
}
```

## With Signing Capability

```rust
use elizaos_plugin_solana::{SolanaClient, WalletConfig};
use rust_decimal::Decimal;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Full access with private key
    let config = WalletConfig::with_keypair(
        "https://api.mainnet-beta.solana.com".to_string(),
        "YourBase58PrivateKey",
    )?;

    let client = SolanaClient::new(config)?;

    // Transfer SOL
    let recipient = Pubkey::from_str("RecipientAddress")?;
    let result = client.transfer_sol(&recipient, Decimal::new(1, 1)).await?;
    println!("Transfer signature: {:?}", result.signature);

    Ok(())
}
```

## Environment Variables

Load configuration from environment:

```rust
let config = WalletConfig::from_env()?;
```

Required:

- `SOLANA_RPC_URL` - Solana RPC endpoint

One of:

- `SOLANA_PRIVATE_KEY` / `WALLET_PRIVATE_KEY` - For signing capability
- `SOLANA_PUBLIC_KEY` / `WALLET_PUBLIC_KEY` - For read-only mode

Optional:

- `SLIPPAGE` - Slippage in basis points (default: 50)
- `HELIUS_API_KEY` - Enhanced RPC features
- `BIRDEYE_API_KEY` - Token price data

## Token Swaps

```rust
use elizaos_plugin_solana::{SwapQuoteParams, WRAPPED_SOL_MINT, USDC_MINT};

let params = SwapQuoteParams {
    input_mint: WRAPPED_SOL_MINT.to_string(),
    output_mint: USDC_MINT.to_string(),
    amount: "1000000000".to_string(), // 1 SOL
    slippage_bps: 50,
};

let quote = client.get_swap_quote(&params).await?;
println!("Expected output: {}", quote.out_amount);

let result = client.execute_swap(&quote).await?;
println!("Swap signature: {:?}", result.signature);
```

## Building

```bash
# Build release
cargo build --release

# Run tests
cargo test

# Run clippy
cargo clippy --all-targets -- -D warnings
```

## Features

- `native` (default): Full async runtime with tokio
- `wasm`: WebAssembly support for browser environments

## License

MIT
