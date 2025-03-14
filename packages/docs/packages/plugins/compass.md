# @elizaos-plugins/plugin-compass

The `@elizaos-plugins/plugin-compass` is a powerful plugin designed to seamlessly integrate the [Compass API](https://api.compasslabs.ai/) into the ElizaOS ecosystem. This integration facilitates the execution of operations on DeFi protocols supported by the Compass API.

## Overview

The Compass plugin leverages the [`@compass-labs/sdk`](https://www.npmjs.com/package/@compass-labs/sdk) TypeScript SDK to provide a suite of actions. These actions correspond to various endpoint calls and schemas defined by the Compass API, enabling efficient interaction with the API.

## Configuration

The plugin requires the following env variables to be set:

```
COMPASS_WALLET_PRIVATE_KEY= <wallet private key>
COMPASS_ARBITRUM_RPC_URL= <arbitrum mainnet rpc url>
COMPASS_ETHEREUM_RPC_URL= <ethereum mainnet rpc url >
COMPASS_BASE_RPC_URL= <base mainnet rpc url>
```

or this can directly be set in the character configuration:

```
...
"settings": {
    "secrets": {
        "COMPASS_WALLET_PRIVATE_KEY": <wallet private key>,
        "COMPASS_ARBITRUM_RPC_URL": <arbitrum mainnet rpc url>,
        "COMPASS_ETHEREUM_RPC_URL": <ethereum mainnet rpc url>,
        "COMPASS_BASE_RPC_URL": <base mainnet rpc url>
    }
},
...
```

## Supported Protocols

For a comprehensive list of supported protocols and available actions, please visit the [Compass API](https://api.compasslabs.ai/) documentation page.

## Installation Instructions

To install the plugin:

```
npx elizaos plugins add @elizaos-plugins/plugin-compass
pnpm run build
```

before starting up eliza

## Character Configuration

Here are some secrets that need to be set if the plugin was to be used together with a telegram client

```
...
"clients": ["telegram"],
...
"settings": {
        ...
        "secrets": {
            "OPENAI_API_KEY": "<YOUR_EXAMPLE>",
            "COMPASS_WALLET_PRIVATE_KEY": "<YOUR_EXAMPLE>",
            "COMPASS_ARBITRUM_RPC_URL": "<YOUR_EXAMPLE>",
            "COMPASS_ETHEREUM_RPC_URL": "<YOUR_EXAMPLE>",
            "COMPASS_BASE_RPC_URL": "<YOUR_EXAMPLE>",
            "TELEGRAM_BOT_TOKEN": "<YOUR_EXAMPLE>"
        }
    },
...
"plugins": ["@elizaos-plugins/plugin-compass"],
...
```

