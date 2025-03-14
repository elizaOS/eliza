# DESK Exchange Plugin for Eliza

This plugin enables interaction with the DESK Perpetual DEX through Eliza, providing perpetual futures trading capabilities. Visit [DESK Exchange](https://desk.exchange/) for more details.
## Features
- 💱 Perpetual Trading
  - Market orders (immediate execution)
  - Limit orders (price-specific)
- 🔄 Order Management
  - Cancel all open orders
- 🏦 Account summary
  - View open orders
  - View active positions
  - View collateral balances

## Installation

Add the plugin to your Eliza configuration:

```json
{
    "plugins": ["@elizaos/plugin-desk-exchange"]
}
```

## Configuration

Set the following environment variables:

```env
DESK_EXCHANGE_PRIVATE_KEY=your_private_key  # Required for trading and cancelling orders
DESK_EXCHANGE_NETWORK=                      # "mainnet" or "testnet
```

## Available Actions

### 1. PERP_TRADE

Place perp market or limit orders.

Examples:

```
# Market Orders
"long 1 BTC"              -> Place buy order of 1 BTC at market price
"sell 2 ETH"              -> Sells 2 ETH at market price
"market buy 1 ETH"        -> Buys 1 ETH at market price

# Limit Orders
"buy 1 SOL at 20 USDC"   -> Places buy order for 1 SOL at 20 USDC
"sell 0.5 BASE at 21 USDC" -> Places sell order for 0.5 BASE at 21 USDC
```

### 2. CANCEL_ORDERS

Cancel all your open orders.

Examples:

```
"Cancel all orders"
"Cancel my orders"
```

### 3. GET_PERP_ACCOUNT_SUMMARY

Display the summary of your current account with details on open orders, active position and collateral tokens.

Examples:

```
"Check my account please"

"Here is the summary of your account 0xxxxxxxx
Your positions:
- Long 1.0039 BTCUSD
- Short 10.01 ETHUSD
- Long 135808.80 SOLUSD
Your orders:
- Sell 0/0.0001 BTCUSD @200000.00
Your collaterals:
- 1382295.125325162 USDC
- 2000000.00 CREDIT"
```

## Security Notes

- Store your private key securely using environment variables
- Test with small amounts first
- Use testnet for initial testing
- Monitor your orders regularly
- Double-check prices before confirming trades

## License

MIT
