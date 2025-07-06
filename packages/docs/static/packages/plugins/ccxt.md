# @elizaos/plugin-ccxt

## Purpose

A plugin for Eliza OS that enables cryptocurrency trading and arbitrage using the CCXT library.

## Key Features

- Check balance of assets across multiple configured exchanges
- Place market and limit buy/sell orders
- Identify arbitrage opportunities between different exchanges

## Installation

```bash
bun install @elizaos/plugin-ccxt
```

## Configuration

Get your API keys from your preferred cryptocurrency exchanges.

Set up your environment variables:

```bash
CCXT_<EXCHANGE>_API_KEY=your_api_key
CCXT_<EXCHANGE>_API_SECRET=your_api_secret
```

Example:

```bash
CCXT_BINANCE_API_KEY=your_binance_api_key
CCXT_BINANCE_API_SECRET=your_binance_api_secret

CCXT_BYBIT_API_KEY=your_bybit_api_key
CCXT_BYBIT_API_SECRET=your_bybit_api_secret
```

## Integration

Available Actions:

- checkbalance: Retrieves the current balance of your assets from a specified exchange
- placeorder: Places a market or limit buy/sell order on a specified exchange
- getarbitrageopportunity: Analyzes price differences across exchanges to identify profitable trades

## Links

- [CCXT DOCUMENTATION](https://docs.ccxt.com/)
