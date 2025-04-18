# @elizaos/plugin-goat

## Purpose

A plugin for integrating blockchain capabilities through the GOAT (Great Onchain Agent Toolkit) framework within the ElizaOS ecosystem.

## Key Features

- Blockchain interaction capabilities including wallets and token management
- Support for multiple chains and protocols
- Actions for sending and checking balances of ETH and USDC
- Token swapping using KIM protocol
- Expandable with additional GOAT plugins

## Installation

```bash
bun install @elizaos/plugin-goat
```

## Configuration

### Environment Variables

```typescript
EVM_PRIVATE_KEY=<Your EVM wallet private key>
EVM_PROVIDER_URL=<Your RPC provider URL (e.g., Infura, Alchemy)>
```

## Integration

The plugin integrates GOAT with Eliza, enabling agents to interact with various blockchain protocols. Users can configure chains, specify actions, and add plugins for different protocols.

## Links

- [GOAT Documentation](https://ohmygoat.dev/)
- [Available Chains](https://ohmygoat.dev/chains)
- [Chains, Wallets & Plugins](https://ohmygoat.dev/chains-wallets-plugins)
- [Smart Wallet Documentation](https://docs.crossmint.com/wallets/smart-wallets/overview)
