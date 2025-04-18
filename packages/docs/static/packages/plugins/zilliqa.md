# @elizaos/plugin-zilliqa

## Purpose

A plugin for integrating Zilliqa blockchain capabilities through the GOAT (Great Onchain Agent Toolkit) framework within the ElizaOS ecosystem.

## Installation

```bash
bun install @elizaos/plugin-zilliqa
```

## Configuration

### Environment Variables

```typescript
EVM_PRIVATE_KEY=<Your EVM wallet private key>
EVM_PROVIDER_URL=<Your RPC provider URL (e.g., Infura, Alchemy)>
ENABLE_ZILLIQA=1
```

## Integration

This plugin integrates the GOAT Zilliqa plugin and wallet with Eliza, allowing blockchain tools such as wallets, token handling, and smart contract interactions.

## Common Issues & Troubleshooting

1. **Agent not executing an action**:

   - Confusion with EVM Plugin action names
   - Character prompts affecting action execution

2. **Wallet Connection Issues**

   - Private key formatting
   - RPC endpoint availability
   - Network balance

3. **Transaction Issues**
   - Gas availability
   - Network congestion
   - Transaction parameters

## Links

[GOAT](https://ohmygoat.dev/)
[Chains supported](https://ohmygoat.dev/chains-wallets-plugins)
[Plugins supported](https://ohmygoat.dev/chains-wallets-plugins)
