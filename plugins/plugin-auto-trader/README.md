# @elizaos/plugin-auto-trader

Autonomous trading plugin for ElizaOS with LLM-powered strategies, Jupiter DEX integration, and comprehensive safety features.

## Features

- **LLM-Powered Trading** - AI analyzes trending tokens and makes intelligent trading decisions
- **Trade ANY Token** - Dynamic token resolution by symbol, name, or address via Birdeye API
- **Jupiter DEX Integration** - Execute swaps with optimal routing on Solana
- **Honeypot Detection** - Blocks scam tokens (no sells, suspicious ratios, low volume)
- **RugCheck Validation** - Automatic token safety checks before trading
- **Risk Management** - Stop-loss, take-profit, position limits, daily loss caps
- **Multiple Strategies** - LLM, Momentum, Mean-Reversion, Rule-based
- **Paper Trading** - Test strategies without risking real funds

## Installation

```bash
npm install @elizaos/plugin-auto-trader
```

## Quick Start

```typescript
import { AgentRuntime } from '@elizaos/core';
import autoTraderPlugin from '@elizaos/plugin-auto-trader';

const runtime = new AgentRuntime({
  character: {
    name: 'Trader',
    settings: {
      SOLANA_PRIVATE_KEY: 'your-base58-private-key',
      BIRDEYE_API_KEY: 'your-birdeye-api-key',
      TRADING_MODE: 'paper', // Start with paper trading!
    },
  },
  plugins: [autoTraderPlugin],
});

await runtime.initialize();
```

## Configuration

### Required Settings

| Setting | Description |
|---------|-------------|
| `SOLANA_PRIVATE_KEY` | Base58-encoded private key for trading wallet |
| `BIRDEYE_API_KEY` | Birdeye API key for market data and token resolution |

### Optional Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `TRADING_MODE` | `paper` | `paper` or `live` |
| `STOP_LOSS_PERCENT` | `5` | Stop loss percentage |
| `TAKE_PROFIT_PERCENT` | `15` | Take profit percentage |
| `MAX_DAILY_LOSS_USD` | `500` | Maximum daily loss before stopping |
| `MIN_LIQUIDITY_USD` | `50000` | Minimum token liquidity |
| `MIN_VOLUME_24H_USD` | `100000` | Minimum 24h trading volume |
| `MIN_SELL_COUNT_24H` | `50` | Minimum sells in 24h (honeypot filter) |
| `MAX_BUY_SELL_RATIO` | `5` | Max buy/sell ratio (honeypot filter) |

## Usage

### Natural Language Commands

**Start Trading:**
```
"Start trading with LLM strategy"
"Begin momentum trading on BONK"
"Start paper trading"
```

**Manual Trades:**
```
"Buy 0.5 SOL worth of BONK"
"Sell 1000 WIF"
"Swap 1 SOL for PEPE"
```

**Check Status:**
```
"Check portfolio"
"Show performance"
"Analyze market"
```

**Configure:**
```
"Set stop loss to 3%"
"Set take profit to 20%"
"Configure liquidity to $100k"
```

### Programmatic Usage

```typescript
const tradingManager = runtime.getService('AutoTradingManager');

// Start automated trading
await tradingManager.startTrading({
  strategy: 'llm',
  tokens: ['auto'], // Auto-discover trending tokens
  maxPositionSize: 0.1, // 10% of portfolio
  intervalMs: 60000,
  stopLossPercent: 5,
  takeProfitPercent: 15,
});

// Check status
const status = tradingManager.getStatus();
console.log('Trading:', status.isTrading);
console.log('P&L:', status.performance.totalPnL);

// Stop trading
await tradingManager.stopTrading();
```

### Direct Swap Execution

```typescript
const swapService = runtime.getService('SwapService');

// Buy tokens
const result = await swapService.buy('TOKEN_ADDRESS', 0.5); // 0.5 SOL
console.log(result.success, result.outputAmount);

// Sell tokens  
await swapService.sell('TOKEN_ADDRESS', 1000);
```

### Token Resolution

```typescript
const resolver = runtime.getService('TokenResolverService');

// Resolve by symbol
const bonk = await resolver.resolve('BONK');
console.log(bonk.address, bonk.price);

// Get trending tokens
const trending = await resolver.getTrendingTokens(20);
```

## Safety Features

### Honeypot Detection

The plugin automatically detects and blocks potential honeypots:

| Check | What It Detects | Default |
|-------|-----------------|---------|
| **Zero Sells** | Tokens with 0 sells in 24h | `minSellCount24h: 50` |
| **Buy/Sell Ratio** | Suspicious trading patterns | `maxBuySellRatio: 5` |
| **Zero Sell Volume** | No sell volume despite buys | Automatic |
| **Token Age** | Tokens less than 24h old | `minTokenAgeSeconds: 86400` |
| **Unique Traders** | Low trader count | `minUniqueTraders24h: 100` |

### RugCheck Integration

- Risk score assessment
- Holder concentration analysis
- Liquidity lock verification
- Mint/freeze authority checks

## Strategies

### LLM Strategy (Recommended)

AI-powered trading using language models:
1. Fetches trending tokens from Birdeye
2. Pre-filters honeypots and scam tokens
3. LLM analyzes remaining safe tokens
4. Validates selection via RugCheck
5. Executes trade with automatic stop-loss/take-profit

### Momentum Strategy

Technical breakout detection using:
- Price momentum indicators
- Volume analysis
- Trend identification

### Mean Reversion Strategy

Trades based on:
- Moving average deviation
- RSI overbought/oversold
- Bollinger Bands

### Rule-Based Strategy

Configurable technical rules:
- Custom RSI thresholds
- SMA/EMA crossovers
- Volume conditions

## Services

| Service | Description |
|---------|-------------|
| `AutoTradingManager` | Main trading orchestrator |
| `SwapService` | Jupiter DEX integration |
| `TokenValidationService` | RugCheck + honeypot detection |
| `TokenResolverService` | Dynamic token resolution |
| `TradingTrajectoryService` | RL training data capture |

## Actions

| Action | Trigger Keywords |
|--------|------------------|
| `START_TRADING` | start, begin, enable trading |
| `STOP_TRADING` | stop, pause, disable trading |
| `CHECK_PORTFOLIO` | portfolio, positions, balance |
| `EXECUTE_LIVE_TRADE` | buy, sell, swap, trade |
| `GET_MARKET_ANALYSIS` | analyze, market, trending |
| `ANALYZE_PERFORMANCE` | performance, p&l, stats |
| `COMPARE_STRATEGIES` | compare, strategies, which |
| `CONFIGURE_STRATEGY` | configure, set, adjust |

## Risk Warnings

⚠️ **Important**: Cryptocurrency trading involves significant risk.

- **Paper Trade First** - Always test strategies before using real funds
- **Start Small** - Begin with small position sizes when going live
- **Monitor Closely** - Keep track of performance
- **Secure Keys** - Never share or commit private keys

## Architecture

```
plugin-auto-trader/
├── package.json
├── prompts/
└── typescript/src/
    ├── index.ts           # Plugin entry point
    ├── services/
    │   ├── AutoTradingManager.ts
    │   ├── SwapService.ts
    │   ├── TokenValidationService.ts
    │   ├── TokenResolverService.ts
    │   └── TradingTrajectoryService.ts
    ├── strategies/
    │   ├── LLMStrategy.ts
    │   ├── MomentumBreakoutStrategy.ts
    │   ├── MeanReversionStrategy.ts
    │   ├── RuleBasedStrategy.ts
    │   └── RandomStrategy.ts
    ├── actions/
    └── providers/
```

## License

MIT
