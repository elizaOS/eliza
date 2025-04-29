# Hyperliquid Plugin for Eliza

## Purpose

This plugin enables interaction with the Hyperliquid DEX through Eliza, providing spot trading capabilities.

## Key Features

- Spot Trading (market and limit orders with price validation)
- Price Checking (real-time price information, 24h change, volume statistics)
- Order Management (cancel all open orders)

## Installation

Add the plugin to your Eliza configuration:

```json
{
  "plugins": ["@elizaos/plugin-hyperliquid"]
}
```

## Configuration

Set the following environment variables:

```env
HYPERLIQUID_PRIVATE_KEY=your_private_key  # Required for trading and cancelling orders
HYPERLIQUID_TESTNET=true_or_false        # Optional, defaults to false
```

## Integration

The plugin provides three main actions: SPOT_TRADE for placing market or limit orders, PRICE_CHECK for getting token price information, and CANCEL_ORDERS for cancelling all open orders.

## Example Usage

```
"buy 1 PIP"              # Market order
"sell 2 HYPE"            # Market order
"buy 1 PIP at 20 USDC"   # Limit order
"What's the price of PIP?" # Price check
"Cancel all orders"      # Cancel orders
```

## Links

License: MIT
