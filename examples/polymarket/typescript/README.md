# Polymarket Demo Agent (TypeScript)

This is a small **autonomous Polymarket demo agent** with a CLI that uses:

- `@elizaos/plugin-evm` for wallet + chain config
- `@elizaos/plugin-polymarket` for Polymarket CLOB access

## Setup

Create a `.env` (or export env vars):

```bash
export EVM_PRIVATE_KEY="0x..."
export CLOB_API_URL="https://clob.polymarket.com"

# Only required for placing orders:
export CLOB_API_KEY="..."
export CLOB_API_SECRET="..."
export CLOB_API_PASSPHRASE="..."
```

## Run

```bash
cd examples/polymarket/typescript
bun install

# Quick config + wallet sanity checks (offline unless you pass --network)
bun run start verify

# Or pass the wallet directly:
bun run start verify --private-key "0x..."

# One dry-run decision tick (fetches markets/orderbook)
bun run start once --network

# Loop every 30s for 10 iterations (dry-run)
bun run start run --network --interval-ms 30000 --iterations 10

# Execute (requires CLOB API creds)
bun run start run --network --execute --interval-ms 30000 --iterations 10
```

## Tests

```bash
cd examples/polymarket/typescript
bun test
```

