# elizaOS Polymarket Trading Agent (TypeScript)

An **AI-powered trading agent** that analyzes Polymarket prediction markets and makes strategic trading decisions using elizaOS.

## Features

This demo showcases core elizaOS capabilities:

- **AgentRuntime** with multiple plugins (SQL, OpenAI, EVM, Polymarket)
- **Message Service Pipeline** for AI decision making via `handleMessage()`
- **Memory Persistence** for trading history via `createMemory()`
- **Character-based AI** with trading personality and strategy
- **Advanced Planning** (`advancedPlanning: true`) for multi-step trading strategies
- **Advanced Memory** (`advancedMemory: true`) for remembering past trades and patterns
- **Autonomy Service** (`runtime.enableAutonomy`) for continuous autonomous trading

## How It Works

1. **Scanning Phase**: Agent scans Polymarket for active markets with order books
2. **Analysis Phase**: Scores opportunities based on spread, liquidity, and midpoint
3. **Decision Phase**: AI agent analyzes top opportunities and decides whether to trade
4. **Execution Phase**: Uses Polymarket plugin actions to place orders

The AI agent ("Poly the Trader") receives market data as messages and responds with trading decisions, using the same pattern as the text-adventure example.

## Setup

Create a `.env` file (or export environment variables):

```bash
# Required
export OPENAI_API_KEY="sk-..."        # For AI decision making
export EVM_PRIVATE_KEY="0x..."        # Wallet for Polymarket

# Optional (defaults shown)
export CLOB_API_URL="https://clob.polymarket.com"
export GAMMA_API_URL="https://gamma-api.polymarket.com"
export PGLITE_DATA_DIR="memory://"    # Use "./polymarket-db" for persistence

# Required only for live trading (--execute)
export CLOB_API_KEY="..."
export CLOB_API_SECRET="..."
export CLOB_API_PASSPHRASE="..."
```

## Usage

```bash
cd examples/polymarket/typescript
bun install

# Verify configuration (offline by default)
bun run start verify
bun run start verify --network  # Also test API connectivity

# AI analyzes markets (dry-run, no real orders)
bun run start once --network

# AI analyzes and places real orders
bun run start once --network --execute

# Continuous trading loop (10 iterations, 30s interval)
bun run start run --network --iterations 10 --interval-ms 30000

# Live continuous trading
bun run start run --network --execute --iterations 10
```

## CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--network` | Enable API calls (required for trading) | false |
| `--execute` | Place real orders (requires CLOB creds) | false |
| `--max-pages <n>` | Pages of markets to scan | 1 |
| `--order-size <n>` | Order size in shares | 1 |
| `--iterations <n>` | Loop count for `run` command | 10 |
| `--interval-ms <n>` | Delay between iterations | 30000 |
| `--chain <name>` | EVM chain name | polygon |
| `--rpc-url <url>` | Custom RPC URL | — |
| `--private-key <hex>` | Override wallet key | — |

## Example Output

```
╔════════════════════════════════════════════════════════════════════╗
║                 POLYMARKET TRADING AGENT                           ║
╠════════════════════════════════════════════════════════════════════╣
║  Watch as Poly the AI Trader analyzes prediction markets!          ║
╚════════════════════════════════════════════════════════════════════╝

✅ Autonomous trading agent ready!
🤖 Advanced Planning: enabled
🧠 Advanced Memory: enabled
🔄 Autonomy: enabled

🔄 PHASE 1: SCANNING MARKETS
────────────────────────────────────────────────────────────────
📊 Scan Results: Source: clob | Markets: 50 | Opportunities: 12

🔄 PHASE 2: AI ANALYSIS
────────────────────────────────────────────────────────────────
🎯 Recommended Market: Will BTC reach $100k by March 2026?
📈 Bid: 0.4500 | Ask: 0.4800
📏 Spread: 0.0300 | Midpoint: 0.4650

────────────────────────────────────────────────────────────────
🤖 Agent Decision: BUY
   Price: 0.4600
   Size: 1 shares
   Reasoning: Tight 3% spread with good liquidity. Bidding below midpoint for favorable entry.
```

## Opportunity Scoring

The agent evaluates markets using:

- **Spread Score** (55%): Tighter spreads indicate better liquidity
- **Midpoint Score** (30%): Prices near 0.5 suggest market uncertainty (good for trading)
- **Depth Score** (15%): More orders on both sides = more reliable pricing

## Architecture

```
polymarket-demo.ts   → Entry point, CLI parsing
runner.ts            → TradingAgent class with elizaOS integration
lib.ts               → Configuration and argument parsing

Key elizaOS patterns:
- AgentRuntime initialization with plugins
- createMessageMemory() for market analysis messages
- runtime.messageService.handleMessage() for AI decisions
- runtime.createMemory() for persisting trading history
```

## Advanced elizaOS Features

### Advanced Planning (`advancedPlanning: true`)

When enabled on the character, the runtime auto-loads the planning service which allows the agent to:
- Plan multi-step trading strategies
- Break down complex decisions into actionable steps
- Maintain planning context across turns

### Advanced Memory (`advancedMemory: true`)

When enabled on the character, the runtime auto-loads advanced memory capabilities:
- Remember past trading decisions and outcomes
- Learn from successful and unsuccessful trades
- Build contextual awareness of market patterns

### Autonomy Service (`runtime.enableAutonomy: true`)

For continuous trading mode (`run` command), autonomy is enabled:
- Creates an "Autonomous Thoughts" room for agent reflection
- Runs periodic thinking loops between trading cycles
- Maintains persistent state across iterations

## Tests

```bash
bun test
```
