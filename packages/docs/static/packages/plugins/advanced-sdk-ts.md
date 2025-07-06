# Coinbase Advanced API TypeScript SDK

## Purpose

A TypeScript SDK that allows developers to easily integrate with the Coinbase Advanced API, providing access to real-time market data, order management, and execution.

## Installation

```bash
bun install
```

## Build and Use

```bash
npm run build
node dist/{INSERT-FILENAME}.js
```

## Configuration

Requires Coinbase Developer Platform (CDP) API keys that must be created by following the instructions in the documentation.

## Integration

Import the RESTClient from the SDK and initialize with API keys:

```
import { RESTClient } from './rest';
const client = new RESTClient(API_KEY, API_SECRET);
```

## Example Usage

- List Accounts: `client.listAccounts({})`
- Get Product: `client.getProduct({productId: "BTC-USD"})`
- Create Order: `client.createOrder()` with appropriate parameters

## Links

- [Coinbase Advanced API](https://docs.cdp.coinbase.com/advanced-trade/docs/welcome)
- [API Reference](https://docs.cdp.coinbase.com/advanced-trade/reference/)
