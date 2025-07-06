# Rabbi Trader Plugin

## Purpose

An automated cryptocurrency trading plugin for Solana tokens with integrated trust scoring, market analysis, and Twitter notifications.

## Key Features

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
bun install @elizaos/plugin-rabbi-trader
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

## Configuration

Safety limits and trading parameters can be configured, including minimum trade amounts, maximum position size, slippage limits, trust scores, stop loss, take profit settings, check intervals, and position limits.

## Integration

The plugin integrates with multiple APIs including Birdeye API, DexScreener, Twitter, and Jupiter for token swaps.

## Example Usage

```typescript
import createRabbiTraderPlugin from '@elizaos/plugin-rabbi-trader';
import { IAgentRuntime } from '@elizaos/core';

const plugin = await createRabbiTraderPlugin((key: string) => process.env[key], runtime);

// Plugin will automatically start monitoring and trading if enabled
```
