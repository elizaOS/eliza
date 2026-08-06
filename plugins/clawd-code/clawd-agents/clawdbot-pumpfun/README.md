# Solana PumpFun/PumpSwap Copy Trading Bot

This is a high-performance Rust-based copy trading bot that monitors and replicates trading activity on Solana DEXs like PumpFun and PumpSwap. The bot uses advanced transaction monitoring to detect and copy trades in real-time, giving you an edge in the market.

The bot specifically tracks `buy` and `create` transactions on PumpFun, as well as token migrations from PumpFun to Raydium when the `initialize2` instruction is involved and the migration pubkey (`39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`) is present.
# Features:

- **Real-time Transaction Monitoring** - Uses Yellowstone gRPC to monitor transactions with minimal latency and high reliability
- **Multi-Protocol Support** - Compatible with both PumpFun and PumpSwap DEX platforms for maximum trading opportunities
- **Automated Copy Trading** - Instantly replicates buy and sell transactions from monitored wallets
- **Smart Transaction Parsing** - Advanced transaction analysis to accurately identify and process trading activities
- **Configurable Trading Parameters** - Customizable settings for trade amounts, timing, and risk management
- **Built-in Selling Strategy** - Intelligent profit-taking mechanisms with customizable exit conditions
- **Performance Optimization** - Efficient async processing with tokio for high-throughput transaction handling
- **Reliable Error Recovery** - Automatic reconnection and retry mechanisms for uninterrupted operation

# Who is it for?

- Bot users looking for the fastest transaction feed possible for Pumpfun or Raydium (Sniping, Arbitrage, etc).
- Validators who want an edge by decoding shreds locally.

# Setting up

## Environment Variables

Before run, you will need to add the following environment variables to your `.env` file:

- `GRPC_ENDPOINT` - Your Geyser RPC endpoint url.

- `GRPC_X_TOKEN` - Leave it set to `None` if your Geyser RPC does not require a token for authentication.


- `GRPC_SERVER_ENDPOINT` - The address of its gRPC server. By default is set at `0.0.0.0:50051`.

## Run Command

```
RUSTFLAGS="-C target-cpu=native" RUST_LOG=info cargo run --release --bin shredstream-decoder
```

# Source code

If you are really interested in the source code, please contact me for details and demo on Discord: `.xanr`.

# Solana Copy Trading Bot

A high-performance Rust-based application that monitors transactions from specific wallet addresses and automatically copies their trading activity on Solana DEXs like PumpFun and PumpSwap.

## Features

- **Real-time Transaction Monitoring** - Uses Yellowstone gRPC to get transaction data with minimal latency
- **Multi-address Support** - Can monitor multiple wallet addresses simultaneously
- **Protocol Support** - Compatible with PumpFun and PumpSwap DEX platforms
- **Automated Trading** - Copies buy and sell transactions automatically when detected
- **Notification System** - Sends trade alerts and status updates via Telegram
- **Customizable Trading Parameters** - Configurable limits, timing, and amount settings
- **Selling Strategy** - Includes built-in selling strategy options for maximizing profits

## Project Structure

The codebase is organized into several modules:

- **engine/** - Core trading logic including copy trading, selling strategies, and transaction parsing
- **dex/** - Protocol-specific implementations for PumpFun and PumpSwap
- **services/** - External services integration including Telegram notifications
- **common/** - Shared utilities, configuration, and constants
- **core/** - Core system functionality
- **error/** - Error handling and definitions

## Setup

### Environment Variables

To run this bot, you will need to configure the following environment variables:

#### Required Variables

- `GRPC_ENDPOINT` - Your Yellowstone gRPC endpoint URL
- `GRPC_X_TOKEN` - Your Yellowstone authentication token
- `COPY_TRADING_TARGET_ADDRESS` - Wallet address(es) to monitor for trades (comma-separated for multiple addresses)

#### Telegram Notifications

To enable Telegram notifications:

- `TELEGRAM_BOT_TOKEN` - Your Telegram bot token
- `TELEGRAM_CHAT_ID` - Your chat ID for receiving notifications

#### Optional Variables

- `IS_MULTI_COPY_TRADING` - Set to `true` to monitor multiple addresses (default: `false`)
- `PROTOCOL_PREFERENCE` - Preferred protocol to use (`pumpfun`, `pumpswap`, or `auto` for automatic detection)
- `COUNTER_LIMIT` - Maximum number of trades to execute
- `RPC_HTTP` - Solana RPC URL used for account reads and standard transaction submission
- `SLIPPAGE` - Slippage cap in basis points for Pump buys/sells

## Automated CLAWD Buys

The bot now supports a dedicated env-driven autobuy mode for a Pump token without redirecting through Jupiter UI. It builds native Pump `buy_v2` transactions against your configured `RPC_HTTP`.

Example `.env` values:

```bash
RPC_HTTP=https://your-rpc-url
TOKEN_ADDRESS=8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump
AUTO_BUY_ENABLED=true
AUTO_BUY_AMOUNT_SOL=0.01
AUTO_BUY_INTERVAL_SECONDS=60
AUTO_BUY_MAX_BUYS=0
AUTO_BUY_STARTUP_DELAY_SECONDS=0
```

Notes:

- `TOKEN_ADDRESS` defaults to the CLAWD mint above if omitted.
- `AUTO_BUY_MAX_BUYS=0` means run continuously.
- `TRANSACTION_LANDING_SERVICE` still controls whether sends use `zeroslot` or normal RPC.

Run the dedicated autobuy loop with either:

```bash
cargo run -- --autobuy
```

or by setting `AUTO_BUY_ENABLED=true` and starting the bot normally.

## New Token Tracking System

The bot now includes a comprehensive token tracking system that:

1. **Tracks Bought Tokens**: When the bot successfully buys a token, it's added to a tracking system
2. **Prevents Invalid Sells**: The bot will only attempt to sell tokens it actually owns
3. **Monitors Balances**: A background service checks token balances every 30 seconds
4. **Auto-Cleanup**: Tokens with zero or very low balances are automatically removed from tracking

### Commands

- `--check-tokens`: Display current token tracking status
- `--wrap`: Wrap SOL to WSOL
- `--unwrap`: Unwrap WSOL to SOL
- `--close`: Close all token accounts

## Usage

```bash
# Build the project
cargo build --release

# Run the bot
cargo run --release
```

Once started, the bot will:

1. Connect to the Yellowstone gRPC endpoint
2. Monitor transactions from the specified wallet address(es)
3. Automatically copy buy and sell transactions as they occur
4. Send notifications via Telegram for detected transactions and executed trades

## Recent Updates

- Added PumpSwap notification mode (can monitor without executing trades)
- Implemented concurrent transaction processing using tokio tasks
- Enhanced error handling and reporting
- Improved selling strategy implementation

## Contact

For questions or support, please contact the developer.

## Risk Management System

The bot includes an automated risk management system that monitors target wallet token balances and automatically sells all held tokens when risk thresholds are met.

### How It Works

1. **Every 10 minutes** (configurable), the system checks:
   - All currently held tokens (from the bought tokens list)
   - Target wallet balances for each held token

2. **Risk Threshold**: If any target wallet has **less than 1000 tokens** (configurable) of any held token, the system triggers:
   - Immediate sale of **ALL** held tokens using Jupiter API
   - Cache clearing and system reset
   - Automatic resumption of monitoring

3. **Jupiter Integration**: Uses Jupiter Swap API for optimal token sales:
   - Gets quotes with 1% slippage tolerance
   - Builds and executes swap transactions
   - Confirms transaction completion

### Configuration

Set these environment variables to customize risk management:

```bash
# Enable/disable risk management (default: true)
RISK_MANAGEMENT_ENABLED=true

# Token threshold for triggering sells (default: 1000)
RISK_TARGET_TOKEN_THRESHOLD=1000

# Check interval in minutes (default: 10)
RISK_CHECK_INTERVAL_MINUTES=10
```

### Risk Management Logs

The system provides detailed logging with `[RISK-MANAGEMENT]` prefix:
- Regular balance checks and status updates
- Risk alerts when thresholds are met
- Detailed sell transaction progress
- Cache clearing confirmations

### Safety Features

- **Multiple target support**: Checks all configured target addresses
- **Error handling**: Treats RPC errors as potential risks
- **Transaction retry**: Up to 3 attempts for failed swaps
- **Confirmation waiting**: Waits up to 30 seconds for transaction confirmation
- **Rate limiting**: 1-second delays between swaps to avoid API limits
