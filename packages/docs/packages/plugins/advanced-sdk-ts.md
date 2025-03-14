# Coinbase Advanced API TypeScript SDK

Welcome to the Coinbase Advanced API TypeScript SDK. This TypeScript project was created to allow developers to easily plug into the [Coinbase Advanced API](https://docs.cdp.coinbase.com/advanced-trade/docs/welcome).

Coinbase Advanced Trade offers a comprehensive API for traders, providing access to real-time market data, order management, and execution. Elevate your trading strategies and develop sophisticated solutions using our powerful tools and features.

For more information on all the available REST endpoints, see the [API Reference](https://docs.cdp.coinbase.com/advanced-trade/reference/).

---

## Installation

```bash
npm install
```

---

## Build and Use

To build the project, run the following command:

```bash
npm run build
```

_Note: To avoid potential issues, do not forget to build your project again after making any changes to it._

After building the project, each `.ts` file will have its `.js` counterpart generated.

To run a file, use the following command:

```
node dist/{INSERT-FILENAME}.js
```

For example, a `main.ts` file would be run like:

```bash
node dist/main.js
```

---

## Coinbase Developer Platform (CDP) API Keys

This SDK uses Cloud Developer Platform (CDP) API keys. To use this SDK, you will need to create a CDP API key and secret by following the instructions [here](https://docs.cdp.coinbase.com/advanced-trade/docs/getting-started).
Make sure to save your API key and secret in a safe place. You will not be able to retrieve your secret again.

---

## Importing the RESTClient

All the REST endpoints are available directly from the client, therefore it's all you need to import.

```
import { RESTClient } from './rest';
```

---

## Authentication

Authentication of CDP API Keys is handled automatically by the SDK when making a REST request.

After creating your CDP API keys, store them using your desired method and simply pass them into the client during initialization like:

```
const client = new RESTClient(API_KEY, API_SECRET);
```

---

## Making Requests

Here are a few examples requests:

**[List Accounts](https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getaccounts)**

```
client
    .listAccounts({})
    .then((result) => {
        console.log(result);
    })
    .catch((error) => {
        console.error(error.message);
    });
```

**[Get Product](https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getproduct)**

```
client
    .getProduct({productId: "BTC-USD"})
    .then((result) => {
        console.log(result);
    })
    .catch((error) => {
        console.error(error.message);
    });
```

**[Create Order](https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_postorder)**

_$10 Market Buy on BTC-USD_

```
client
    .createOrder({
        clientOrderId: "00000001",
        productId: "BTC-USD",
        side: OrderSide.BUY,
        orderConfiguration:{
            market_market_ioc: {
                quote_size: "10"
            }
        }
    })
    .then((result) => {
        console.log(result);
    })
    .catch((error) => {
        console.error(error.message);
    });
```
