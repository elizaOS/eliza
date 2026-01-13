# Auto Trader Example

A simple trading bot interface that demonstrates the `@elizaos/plugin-auto-trader` capabilities.

## Features

- **Wallet Setup**: Configure your Solana wallet for trading
- **Strategy Selection**: Choose from LLM, Momentum, Mean-Reversion, or Rule-based strategies
- **Trading Controls**: Start/Stop auto-trading with configurable parameters
- **Position Monitor**: View open positions with real-time P&L
- **Trade History**: Track recent trades and performance

## Quick Start

```bash
cd typescript
bun install
bun dev
```

Then open http://localhost:5173 in your browser.

## Configuration

Set the following environment variables or configure in the UI:

```env
SOLANA_PRIVATE_KEY=your_base58_private_key
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
BIRDEYE_API_KEY=your_birdeye_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key  # Required for LLM strategy
```

## Trading Modes

### Paper Trading (Default)
Simulates trades without executing real transactions. Perfect for testing strategies.

### Live Trading
Executes real trades on Solana. **Use with caution and small amounts.**

## Strategies

### LLM Strategy
Uses AI to analyze trending tokens from Birdeye and make trading decisions with:
- Market assessment and token analysis
- Opportunity and risk scoring
- Automatic stop-loss and take-profit levels

### Momentum Strategy
Technical analysis based strategy using:
- Price momentum indicators
- Volume analysis
- Breakout detection

### Mean Reversion Strategy
Trades based on:
- Price deviation from moving averages
- Bollinger Bands
- RSI overbought/oversold signals

### Rule-Based Strategy
Configurable technical indicator rules:
- RSI thresholds
- SMA/EMA crossovers
- MACD signals

## Safety Features

- **Honeypot Detection**: Blocks tokens with no sells, suspicious buy/sell ratios, or zero sell volume
- **RugCheck Integration**: Validates tokens for rug pull indicators
- **Token Age Filter**: Avoids tokens that are too new (configurable)
- **Liquidity/Volume Requirements**: Ensures sufficient trading activity
- **Position Size Limits**: Configurable max allocation per trade
- **Stop-Loss Protection**: Automatic position exits on losses
- **Daily Loss Limits**: Stops trading after reaching max daily loss

## Architecture

```
trader/
├── typescript/
│   ├── src/
│   │   ├── main.tsx           # React entry point
│   │   ├── App.tsx            # Main application
│   │   ├── components/
│   │   │   ├── WalletSetup.tsx
│   │   │   ├── TradingPanel.tsx
│   │   │   ├── PositionList.tsx
│   │   │   ├── TradeHistory.tsx
│   │   │   └── StrategySelect.tsx
│   │   ├── runtime/
│   │   │   ├── index.ts       # Runtime singleton
│   │   │   └── character.ts   # Trader character config
│   │   └── hooks/
│   │       └── useTrading.ts  # Trading state hook
```

## License

MIT
