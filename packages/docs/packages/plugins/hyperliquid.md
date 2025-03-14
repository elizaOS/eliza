# Hyperliquid Plugin for Eliza

This plugin enables interaction with the Hyperliquid DEX through Eliza, providing spot trading capabilities.

## Features

- 💱 Spot Trading
    - Market orders (immediate execution)
    - Limit orders (price-specific)
    - Smart price validation to prevent mistakes
- 📊 Price Checking
    - Real-time price information
    - 24h price change
    - Volume statistics
- 🔄 Order Management
    - Cancel all open orders
    - Clear feedback on execution

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

## Available Actions

### 1. SPOT_TRADE

Place spot market or limit orders.

Examples:

```
# Market Orders
"buy 1 PIP"              -> Buys 1 PIP at market price
"sell 2 HYPE"            -> Sells 2 HYPE at market price
"market buy 1 ETH"       -> Buys 1 ETH at market price

# Limit Orders
"buy 1 PIP at 20 USDC"   -> Places buy order for 1 PIP at 20 USDC
"sell 0.5 HYPE at 21 USDC" -> Places sell order for 0.5 HYPE at 21 USDC
```

### 2. PRICE_CHECK

Get current price information for any token.

Examples:

```
"What's the price of PIP?"
"Check HYPE price"
"Get ETH price"
```

Returns: Current price, 24h change, and volume.

### 3. CANCEL_ORDERS

Cancel all your open orders.

Examples:

```
"Cancel all orders"
"Cancel my orders"
```

## Price Validation

The plugin includes smart price validation to prevent mistakes:

- Market Orders: Validates price is within ±50% of market price
- Limit Orders:
    - Buy orders must be below market price
    - Sell orders must be above market price
    - Warns if price is very different from market (±80%)

## Error Handling

The plugin provides clear error messages for common issues:

- Invalid token symbols
- Price validation failures
- Network connection issues
- Order execution failures

## Security Notes

- Store your private key securely using environment variables
- Test with small amounts first
- Use testnet for initial testing
- Monitor your orders regularly
- Double-check prices before confirming trades

## License

MIT
