# @elizaos/plugin-lightlink

## Description

The LightLink Plugin allows agents to interact with the LightLink network.

## Features

The plugin lets agents:

- Check balances.
- Transfer both ERC20 and Eth.
- Swap (via Elektrik)
- Search the block explorer for contracts and addresses.

## Installation

```
pnpm add @elizaos/plugin-lightlink
```

## Configuration

### Required Environment Variables

```env
# Required
EVM_PRIVATE_KEY=your-private-key-here

# Optional - Custom RPC URLs
LIGHTLINK_MAINNET_RPC_URL=https://your-custom-mainnet-rpc-url
LIGHTLINK_TESTNET_RPC_URL=https://your-custom-testnet-rpc-url
```

### Chain Configuration

By default, **LightLink Phoenix (mainnet)** is enabled. To enable additional chains, add them to your character config:

```json
"settings": {
    "chains": {
        "evm": [
            "lightlinkTestnet", "ethereum", "sepolia"
        ]
    }
}
```

## Actions

### Check Balance

Check the balance of an address. All address can be written as an ENS name or a raw address.

```typescript
// Example: Check balance of 0x742d35Cc6634C0532925a3b844Bc454e4438f44e
Check the balance of vitalik.eth on lightlink
```

### Transfer

Transfer native tokens on the same chain:

```typescript
// Example: Transfer 1 ETH
Transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e
```

### Swap

Swap tokens on the same chain, you can also provide the address of the tokens you want to swap directly.

```typescript
// Example: Swap 1 ETH to USDC
Swap 1 ETH to USDC on lightlink testnet
```

### Search

Search the block explorer for contracts and addresses.

```typescript
// Example: Search for a contract
Whats the contract address for the USDC (sometimes written as USDC.e) token on lightlink?
```

## Development

1. Clone the repository
2. Install dependencies:
   pnpm install
3. Build the plugin:
   pnpm run build
4. Run tests:
   pnpm test
