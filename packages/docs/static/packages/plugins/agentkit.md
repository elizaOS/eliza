# @elizaos/plugin-agentkit

## Purpose

AgentKit plugin for Eliza that enables interaction with CDP AgentKit tools for NFT and token management.

## Installation

```bash
bun install
```

## Configuration

Environment variables:

```env
CDP_API_KEY_NAME=your_key_name
CDP_API_KEY_PRIVATE_KEY=your_private_key
CDP_AGENT_KIT_NETWORK=base-sepolia # Optional: Defaults to base-sepolia
```

Character configuration:

```json
{
  "plugins": ["@elizaos/plugin-agentkit"],
  "settings": {
    "secrets": {
      "CDP_API_KEY_NAME": "your_key_name",
      "CDP_API_KEY_PRIVATE_KEY": "your_private_key"
    }
  }
}
```

## Key Features

Available tools:

- GET_WALLET_DETAILS
- DEPLOY_NFT
- DEPLOY_TOKEN
- GET_BALANCE
- MINT_NFT
- REGISTER_BASENAME
- REQUEST_FAUCET_FUNDS
- TRADE
- TRANSFER
- WOW_BUY_TOKEN
- WOW_SELL_TOKEN
- WOW_CREATE_TOKEN

Supported networks:

- Base Sepolia (default)
- Base Mainnet

## Example Usage

- Get wallet details: "Can you show me my wallet details?"
- Deploy NFT collection: "Deploy a new NFT collection called 'Music NFTs' with symbol 'MUSIC'"
- Create token: "Create a new WOW token called 'Artist Token' with symbol 'ART'"
- Check balance: "What's my current balance?"
