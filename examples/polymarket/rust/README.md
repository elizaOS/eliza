# Polymarket Demo Agent (Rust)

Autonomous Polymarket demo CLI using:

- `elizaos-plugin-evm` (wallet + chain utilities)
- `elizaos-plugin-polymarket` (CLOB client)

## Run

```bash
cd examples/polymarket/rust/polymarket-demo
cargo run -- verify

# network usage (fetch markets/orderbook)
cargo run -- once --network

# loop
cargo run -- run --network --iterations 10 --interval-ms 30000
```

## Config

```bash
export EVM_PRIVATE_KEY="0x..."
export CLOB_API_URL="https://clob.polymarket.com"

# only for --execute
export CLOB_API_KEY="..."
export CLOB_API_SECRET="..."
export CLOB_API_PASSPHRASE="..."
```

