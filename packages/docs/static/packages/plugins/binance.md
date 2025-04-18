# Binance Plugin for Eliza

## Purpose

This plugin enables Eliza to interact with the Binance cryptocurrency exchange, providing capabilities for checking prices, executing trades, and managing spot wallet balances.

## Key Features

- Real-time cryptocurrency price checks
- Spot trading (market and limit orders)
- Wallet balance inquiries
- Comprehensive error handling
- Secure API integration

## Prerequisites

1. Binance Account
2. API Keys with spot trading permissions

## Configuration

Set environment variables:

```env
BINANCE_API_KEY=your_api_key
BINANCE_SECRET_KEY=your_secret_key
```

## Installation

```json
{
  "plugins": ["@elizaos/plugin-binance"]
}
```

## Integration

The plugin provides three actions:

1. GET_PRICE: Check cryptocurrency prices
2. EXECUTE_SPOT_TRADE: Execute spot trades
3. GET_SPOT_BALANCE: Check wallet balances

## Example Usage

- "What's the current price of Bitcoin?"
- "Buy 0.1 BTC at market price"
- "What's my BTC balance?"
