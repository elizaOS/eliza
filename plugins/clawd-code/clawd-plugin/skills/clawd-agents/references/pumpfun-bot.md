# PumpFun/PumpSwap Bot Reference

Source: `/Users/8bit/clawd-code/clawd-agents/clawdbot-pumpfun`

This package is a Rust copy-trading bot for Solana PumpFun and PumpSwap flows. It monitors target wallet activity over Yellowstone gRPC, parses buy/create/migration behavior, and can copy trades, run a dedicated autobuy loop, send Telegram notifications, and enforce risk-management exits.

## Source Layout

| Path | Purpose |
|---|---|
| `src/main.rs` | CLI entrypoint |
| `src/engine` | Copy trading, selling strategy, monitor, swap, parallel processing, transaction parsing |
| `src/dex` | PumpFun and PumpSwap protocol implementations |
| `src/services` | RPC, ZeroSlot, balance manager, token monitor, Telegram, risk management |
| `src/common` | Config, constants, logging, cache |
| `src/core` | Core transaction/token helpers |
| `CONFIGURATION_GUIDE.md` | Env contract and debugging commands |
| `PARALLEL_PROCESSING_GUIDE.md` | Throughput and concurrency guidance |

## Required Environment

| Variable | Purpose |
|---|---|
| `GRPC_ENDPOINT` or `YELLOWSTONE_GRPC_HTTP` | Yellowstone/Geyser gRPC endpoint |
| `GRPC_X_TOKEN` or `YELLOWSTONE_GRPC_TOKEN` | gRPC auth token, if required |
| `COPY_TRADING_TARGET_ADDRESS` | Target wallet or comma-separated wallets |
| `WALLET_PRIVATE_KEY` | Trading wallet secret; never commit or print |
| `COUNTER_LIMIT` | Maximum number of trades to execute |

## Common Trading Settings

| Variable | Purpose |
|---|---|
| `TOKEN_AMOUNT` | Trade size |
| `SLIPPAGE` | Slippage cap in basis points |
| `PROTOCOL_PREFERENCE` | `pumpfun`, `pumpswap`, or `auto` |
| `IS_MULTI_COPY_TRADING` | Enables multiple target wallets |
| `IS_PROGRESSIVE_SELL` | Enables progressive sell behavior |
| `IS_COPY_SELLING` | Enables copy-selling behavior |
| `TRANSACTION_LANDING_SERVICE` | `zeroslot` or normal RPC |
| `RPC_HTTP` | HTTP RPC for account reads and normal submission |

## Autobuy Mode

The bot can run an env-driven autobuy loop for a Pump token.

| Variable | Purpose |
|---|---|
| `TOKEN_ADDRESS` | Token mint; defaults to the CLAWD mint if omitted |
| `AUTO_BUY_ENABLED` | Enables autobuy |
| `AUTO_BUY_AMOUNT_SOL` | SOL per buy |
| `AUTO_BUY_INTERVAL_SECONDS` | Delay between buys |
| `AUTO_BUY_MAX_BUYS` | `0` means continuous |
| `AUTO_BUY_STARTUP_DELAY_SECONDS` | Delay before first buy |

Run with:

```bash
cargo run -- --autobuy
```

## Token Tracking

Token tracking records bought tokens, avoids invalid sells, monitors balances, and removes zero/near-zero balances from the tracked set. Useful commands:

```bash
cargo run --release -- --check-tokens
cargo run --release -- --wrap
cargo run --release -- --unwrap
cargo run --release -- --close
```

## Risk Management

Risk management checks target wallet balances for held tokens and can sell all held tokens if a target falls below the configured threshold.

| Variable | Purpose |
|---|---|
| `RISK_MANAGEMENT_ENABLED` | Enable/disable risk checks |
| `RISK_TARGET_TOKEN_THRESHOLD` | Trigger threshold |
| `RISK_CHECK_INTERVAL_MINUTES` | Check interval |

## Operator Rules

- Start in monitor-only, dry-run, or very small-size mode.
- Require explicit target wallets, counter limits, slippage caps, and wallet funding checks.
- Confirm the gRPC endpoint is delivering expected target transactions before enabling copies.
- Check token tracking with `--check-tokens` before and after a live session.
- Treat RPC errors during risk checks as serious; fail conservative.
- Use Telegram notifications for live unattended monitoring, but do not rely on notifications as the only kill switch.
