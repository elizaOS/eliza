# Unmaintained: this plugin needs a maintainer.

# Rabbi Trader Plugin

An automated cryptocurrency trading plugin for Solana tokens with integrated trust scoring, market analysis, and Twitter notifications.

## Features

- Automated trading on Solana blockchain
- Real-time market data analysis using DexScreener
- Trust score evaluation for tokens
- Twitter integration for trade notifications
- Safety limits and risk management
- Simulation capabilities before executing trades
- Performance tracking and trade history
- Rate limiting and cache management

## Installation

```bash
npm install @elizaos/plugin-rabbi-trader
```

## Prerequisites

The following environment variables need to be configured:

- `WALLET_PRIVATE_KEY`: Your Solana wallet private key
- `WALLET_PUBLIC_KEY`: Your Solana wallet public address
- `SOLANA_RPC_URL`: Solana RPC endpoint (defaults to mainnet)
- `BIRDEYE_API_KEY`: API key for Birdeye data provider
- `TWITTER_ENABLED`: Enable/disable Twitter notifications
- `TWITTER_USERNAME`: Twitter username for notifications
- `DEXSCREENER_WATCHLIST_ID`: DexScreener watchlist identifier
- `COINGECKO_API_KEY`: CoinGecko API key for additional market data

## Usage

```typescript
import createRabbiTraderPlugin from '@elizaos/plugin-rabbi-trader';
import { IAgentRuntime } from '@elizaos/core';

const plugin = await createRabbiTraderPlugin(
  (key: string) => process.env[key],
  runtime
);

// Plugin will automatically start monitoring and trading if enabled
```

## Configuration

### Safety Limits

The plugin includes built-in safety limits that can be configured:

```typescript
export const SAFETY_LIMITS = {
  MINIMUM_TRADE: 0.01,        // Minimum SOL per trade
  MAX_POSITION_SIZE: 0.1,     // Maximum 10% of token liquidity
  MAX_SLIPPAGE: 0.05,        // Maximum 5% slippage allowed
  MIN_LIQUIDITY: 1000,       // Minimum $1000 liquidity required
  MIN_VOLUME: 2000,          // Minimum $2000 24h volume required
  MIN_TRUST_SCORE: 0.4,      // Minimum trust score to trade
  STOP_LOSS: 0.2,           // 20% stop loss trigger
  TAKE_PROFIT: 0.12,        // Take profit at 12% gain
  TRAILING_STOP: 0.2        // 20% trailing stop from highest
};
```

### Trading Parameters

Default trading parameters can be adjusted in the configuration:

```typescript
{
  CHECK_INTERVAL: 5 * 60 * 1000,     // Check every 5 minutes
  REENTRY_DELAY: 60 * 60 * 1000,     // Wait 1 hour before re-entering
  MAX_ACTIVE_POSITIONS: 5,           // Maximum concurrent positions
  MIN_WALLET_BALANCE: 0.05           // Keep minimum 0.05 SOL in wallet
}
```

## API Integration

The plugin integrates with multiple APIs:

- **Birdeye API**: Market data and token security information
- **DexScreener**: Real-time trading data and market analysis
- **Twitter**: Trade notifications and updates
- **Jupiter**: Token swaps and liquidity aggregation

## Error Handling

The plugin includes comprehensive error handling for common scenarios:

```typescript
export const ERROR_SIGNATURES = [
  {
    sig: "0x13be252b",
    name: "InsufficientAllowance",
    description: "Token allowance too low"
  },
  {
    sig: "0xf4d678b8",
    name: "InsufficientBalance",
    description: "Insufficient token balance"
  },
  // ... additional error signatures
];
```

## Trade Analysis

The plugin performs detailed analysis before executing trades:

1. Token security evaluation
2. Market data analysis
3. Trust score calculation
4. Liquidity assessment
5. Volume verification
6. Price movement analysis
7. Holder distribution review

## Twitter Integration

When enabled, the plugin can post trade notifications with:

- Token information
- Trade details (buy/sell price, amount)
- Trust score and risk level
- Market metrics
- Transaction signature
- Profit/loss for sells

## Caching

The plugin implements multiple caching mechanisms:

- Token analysis cache (20 minutes)
- Twitter rate limiting cache (hourly limits)
- Skip/wait cache (2 hours)
- Analysis history (24 hours)

## Development

### Building

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

## Dependencies

Key dependencies include:

- `@solana/web3.js`: Solana blockchain interaction
- `@elizaos/core`: Core agent runtime
- `@elizaos/plugin-solana`: Solana integration
- `@elizaos/plugin-trustdb`: Trust score database
- `node-cache`: Caching functionality
- `bignumber.js`: Precise number handling

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
