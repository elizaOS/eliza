# @elizaos/plugin-para

## Purpose

A seamless integration between Para wallet infrastructure and Eliza OS, enabling autonomous agents to manage user wallets and transactions.

## Key Features

- 🔐 Full Para wallet integration with Eliza agents
- 💰 EVM-based transaction support using Viem
- 📝 Message signing capabilities
- 💼 Pre-generated wallet support
- 🔄 Seamless wallet claiming process
- 🛡️ Secure user share management
- 🌐 Multi-chain support (Ethereum, Polygon, Arbitrum, etc.)
- 📋 Built-in wallet status monitoring
- 🤖 Auto-configuration with Eliza agents
- 📱 Session management for persistent authentication

## Installation

```bash
# npm
bun install @elizaos/plugin-para

# bun
bun add @elizaos/plugin-para

# yarn
yarn add @elizaos/plugin-para

# bun
bun add @elizaos/plugin-para
```

## Configuration

1. Add required environment variables to your `.env` file
2. Register the plugin in your Eliza character configuration

## Integration

The plugin adds wallet creation, message signing, transaction signing, and wallet claiming capabilities to Eliza agents through actions, providers, and services.

## Example Usage

```typescript
// Creating wallets
await runtime.triggerAction('CREATE_PARA_WALLET', {
  type: 'EVM',
});

// Signing messages
await runtime.triggerAction('SIGN_PARA_MESSAGE', {
  walletId: 'wallet-id',
  message: 'Hello, World!',
});
```

## Links

- [Eliza Documentation](https://elizaos.github.io/eliza/)
- [Para Documentation](https://docs.getpara.com/)
- [Plugin Examples](https://github.com/elizaos/eliza/tree/main/examples/plugins)
- [Viem Documentation](https://viem.sh/)
