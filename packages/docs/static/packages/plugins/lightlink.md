# @elizaos/plugin-lightlink

## Purpose

The LightLink Plugin allows agents to interact with the LightLink network.

## Key Features

- Check balances
- Transfer both ERC20 and Eth
- Swap (via Elektrik)
- Search the block explorer for contracts and addresses

## Installation

```
bun add @elizaos/plugin-lightlink
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

By default, LightLink Phoenix (mainnet) is enabled. Additional chains can be added in the character config.

## Example Usage

- Check balance: `Check the balance of vitalik.eth on lightlink`
- Transfer: `Transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e`
- Swap: `Swap 1 ETH to USDC on lightlink testnet`
- Search: `Whats the contract address for the USDC token on lightlink?`
