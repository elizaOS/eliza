# Polymarket Demo Agent (Rust)

Autonomous Polymarket demo CLI using:

- `elizaos-plugin-evm` (wallet + chain utilities)
- `elizaos-plugin-polymarket` (CLOB client)

## Setup

```bash
cd examples/polymarket/rust/polymarket-demo
```

## Configure

```bash
export EVM_PRIVATE_KEY="0x..."
export CLOB_API_URL="https://clob.polymarket.com"
export GAMMA_API_URL="https://gamma-api.polymarket.com"

# Only required for placing orders (not yet supported in Rust):
export CLOB_API_KEY="..."
export CLOB_API_SECRET="..."
export CLOB_API_PASSPHRASE="..."
```

## Run

```bash
cargo run -- verify

# network usage (fetch markets/orderbook)
cargo run -- once --network

# loop
cargo run -- run --network --iterations 10 --interval-ms 30000

# execute is not supported in Rust yet
```

## Tests

```bash
cargo test
```
