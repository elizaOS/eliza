# plugin-gelato

## Purpose

A powerful plugin to interact with smart contracts using Gelato Relay, supporting both ERC2771 (meta transactions) and non-ERC2771 calls on any EVM-compatible blockchain.

## Key Features

- Sponsored Calls: Interact with contracts without needing gas on the user's side
- ERC2771 Support: Execute meta-transactions via Gelato's sponsoredCallERC2771
- Customizable: Easily configure chains, contracts, and user-specific settings

## Installation

```
bun install elizaos/plugin-gelato
```

## Configuration

Fill out the `.env` file in the project root:

```
GELATO_RELAY_API_KEY=<Your Gelato Relay API Key>
EVM_PROVIDER_URL=<Your EVM provider URL (e.g., Alchemy or Infura endpoint)>
EVM_PRIVATE_KEY=<Your wallet's private key>
```

## Example Usage

- Non-ERC2771 (Standard Sponsored Call) to call increment() function
- ERC2771 (Meta-Transactions) to call increment() with user address
- Successful execution returns confirmation with task ID and tracking link

## Troubleshooting

- Ensure proper .env configuration
- Verify contract ABI, function name, and chain details
- For ERC2771 calls, confirm User address is correct
