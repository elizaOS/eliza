# Binance Plugin for Eliza

This plugin enables Eliza to interact with the Binance cryptocurrency exchange, providing capabilities for checking prices, executing trades, and managing spot wallet balances.

## Features

- 📊 Real-time cryptocurrency price checks
- 💱 Spot trading (market and limit orders)
- 💰 Wallet balance inquiries
- ✅ Comprehensive error handling
- 🔒 Secure API integration

## Prerequisites

1. **Binance Account**: You need a Binance account to use this plugin
2. **API Keys**: Generate API keys from your Binance account:
    - Go to your Binance account settings
    - Navigate to API Management
    - Create a new API key
    - Enable spot trading permissions
    - Store your API key and secret securely

## Configuration

Set the following environment variables:

```env
BINANCE_API_KEY=your_api_key
BINANCE_SECRET_KEY=your_secret_key
```

## Installation

Add the plugin to your Eliza configuration:

```json
{
    "plugins": ["@elizaos/plugin-binance"]
}
```

## Available Actions

The plugin provides the following actions:

1. **GET_PRICE**: Check cryptocurrency prices

    - Example: "What's the current price of Bitcoin?"
    - Example: "Check ETH price in USDT"

2. **EXECUTE_SPOT_TRADE**: Execute spot trades

    - Example: "Buy 0.1 BTC at market price"
    - Example: "Sell 100 USDT worth of ETH"

3. **GET_SPOT_BALANCE**: Check wallet balances
    - Example: "What's my BTC balance?"
    - Example: "Show all my wallet balances"

## Important Notes

1. **API Rate Limits**: Binance implements rate limiting:

    - 1200 requests per minute for most endpoints
    - Some endpoints have specific weight limits
    - The plugin handles rate limiting errors appropriately

2. **Minimum Order Sizes**: Binance enforces minimum order sizes and notional values:

    - Minimum order size varies by trading pair
    - Minimum notional value (quantity × price) must be met
    - The plugin validates these requirements before order execution

3. **Error Handling**: The plugin provides detailed error messages for:
    - Invalid API credentials
    - Insufficient balance
    - Invalid trading pairs
    - Minimum notional value not met
    - Other API-specific errors

## Service Architecture

The plugin is organized into specialized services:

- `PriceService`: Handles price-related operations
- `TradeService`: Manages trading operations
- `AccountService`: Handles balance and account operations
- `BaseService`: Provides common functionality
