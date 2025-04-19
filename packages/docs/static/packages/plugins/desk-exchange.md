# DESK Exchange Plugin for Eliza

## Purpose

Enables interaction with the DESK Perpetual DEX through Eliza, providing perpetual futures trading capabilities.

## Key Features

- Perpetual Trading (market and limit orders)
- Order Management (cancel all open orders)
- Account summary (view open orders, active positions, collateral balances)

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

## Integration

Provides three actions to interact with DESK Exchange:

1. PERP_TRADE - Place market or limit orders
2. CANCEL_ORDERS - Cancel all open orders
3. GET_PERP_ACCOUNT_SUMMARY - Display account summary with positions, orders and collaterals

## Links

[DESK Exchange](https://desk.exchange/)
