# @elizaos/plugin-starknet

## Purpose

Core Starknet blockchain plugin for Eliza OS that provides essential services and actions for token operations, trading, and DeFi integrations.

## Key Features

- **Token Operations**: Token creation, transfers, balance management, portfolio analytics
- **Trading Operations**: Token swaps, order management, price monitoring, trust score analysis
- **DeFi Integration**: Liquidity management, yield optimization, risk assessment, performance tracking

## Configuration

The plugin requires the following environment variables:

```typescript
STARKNET_ADDRESS = your_starknet_address;
STARKNET_PRIVATE_KEY = your_private_key;
STARKNET_RPC_URL = your_rpc_url; // e.g. https://rpc.starknet.lava.build
```

## Integration

Serves as a foundational component of Eliza OS, bridging Starknet blockchain capabilities with the Eliza ecosystem, enabling both automated and user-directed interactions.

## Example Usage

```typescript
// Deploy token
const result = await runtime.executeAction('DEPLOY_STARKNET_UNRUGGABLE_MEME_TOKEN', {
  name: 'TokenName',
  symbol: 'TKN',
  owner: 'OwnerAddressHere',
  initialSupply: '1000000000000000000',
});

// Transfer tokens
const result = await runtime.executeAction('TRANSFER_TOKEN', {
  tokenAddress: 'TokenAddressHere',
  recipient: 'RecipientAddressHere',
  amount: '1000',
});
```

## Links

- [Starknet Documentation](https://docs.starknet.io/)
- [Starknet Developer Portal](https://starknet.io/developers)
- [Starknet Network Dashboard](https://starknet.io/dashboard)
- [Starknet GitHub Repository](https://github.com/starkware-libs/starknet)
