# @elizaos/plugin-para

A seamless integration between Para wallet infrastructure and Eliza OS, enabling autonomous agents to manage user wallets and transactions.

[![npm version](https://img.shields.io/npm/v/@elizaos/plugin-para?color=blue)](https://npmjs.com/package/@elizaos/plugin-para)
[![npm downloads](https://img.shields.io/npm/dm/@elizaos/plugin-para?color=blue)](https://npm.chart.dev/@elizaos/plugin-para)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@elizaos/plugin-para?color=blue)](https://bundlephobia.com/package/@elizaos/plugin-para)

## Features

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

You can install the plugin using your preferred package manager:

```bash
# npm
npm install @elizaos/plugin-para

# pnpm
pnpm add @elizaos/plugin-para

# yarn
yarn add @elizaos/plugin-para

# bun
bun add @elizaos/plugin-para
```

## Configuration

1. Add required environment variables to your `.env` file:

```env
# Para Configuration
PARA_API_KEY=your-para-api-key
PARA_ENV=production
```

2. Register the plugin in your Eliza character configuration:

```typescript
import { paraPlugin } from '@elizaos/plugin-para';

export const characterConfig = {
  // ... other config
  plugins: [paraPlugin],
  settings: {
    secrets: {
      PARA_API_KEY: process.env.PARA_API_KEY,
      PARA_ENV: process.env.PARA_ENV || 'production'
    }
  }
};
```

## Usage

The plugin adds several capabilities to your Eliza agent:

### Creating Wallets

```typescript
// The agent can create wallets in response to user requests
await runtime.triggerAction("CREATE_PARA_WALLET", {
  type: "EVM"
});
```

### Pre-generating Wallets

```typescript
// Create a wallet for a user before they sign up
await runtime.triggerAction("CREATE_PREGEN_WALLET", {
  pregenIdentifier: "user@example.com",
  pregenIdentifierType: "EMAIL"
});
```

### Signing Messages

```typescript
// Sign a message with a user's wallet
await runtime.triggerAction("SIGN_PARA_MESSAGE", {
  walletId: "wallet-id",
  message: "Hello, World!"
});
```

### Signing Transactions

```typescript
// Sign and submit an EVM transaction
await runtime.triggerAction("SIGN_PARA_TRANSACTION", {
  walletId: "wallet-id",
  transaction: {
    to: "0x1234567890123456789012345678901234567890",
    value: "0.01"
  },
  chainId: "1" // Ethereum mainnet
});
```

### Claiming Pre-generated Wallets

```typescript
// Users can claim their pre-generated wallets
await runtime.triggerAction("CLAIM_PARA_WALLET", {
  pregenIdentifier: "user@example.com",
  pregenIdentifierType: "EMAIL"
});
```

### Checking Wallet Status

```typescript
// Get current wallet status through the provider
const walletInfo = await runtime.getContextFromProvider("paraWalletProvider");
```

## Actions

The plugin provides the following actions:

| Action | Description |
|--------|-------------|
| `CREATE_PARA_WALLET` | Creates a new Para wallet |
| `CREATE_PREGEN_WALLET` | Creates a pre-generated wallet associated with an identifier |
| `CLAIM_PARA_WALLET` | Claims a pre-generated wallet |
| `SIGN_PARA_MESSAGE` | Signs a message using a Para wallet |
| `SIGN_PARA_TRANSACTION` | Signs and submits a transaction using a Para wallet |
| `UPDATE_PREGEN_IDENTIFIER` | Updates the identifier for a pre-generated wallet |

## Providers

Available providers for context and status:

| Provider | Description |
|----------|-------------|
| `paraWalletProvider` | Provides current wallet information and status |

## Services

The plugin registers the following services in the Eliza runtime:

| Service | Description |
|---------|-------------|
| `ParaWalletService` | Core service handling Para SDK integration |

## Viem Integration

The plugin uses Viem for Ethereum transactions, offering:

- 🚀 Modern and efficient transaction handling
- 🔧 Type-safe API for Ethereum interactions
- ⚡ Multi-chain support out of the box
- 🔄 Compatible with the Para Viem connector

```typescript
// Example of transaction handling with Viem
await runtime.triggerAction("SIGN_PARA_TRANSACTION", {
  walletId: "wallet-id",
  transaction: {
    to: "0x1234567890123456789012345678901234567890",
    value: "0.05",
    data: "0x..." // Optional contract interaction data
  },
  chainId: "137" // Polygon
});
```

## Session Management

The plugin implements Para's session management for maintaining authenticated states:

```typescript
const paraService = runtime.getService<ParaWalletService>(ExtendedServiceType.PARA_WALLET);

// Check if session is active
const isActive = await paraService.isSessionActive();

// Keep session alive
if (isActive) {
  await paraService.keepSessionAlive();
} else {
  await paraService.refreshSession();
}
```

## User Share Management

Secure handling of user shares for pre-generated wallets:

```typescript
// Get user share after wallet creation
const { wallet, userShare } = await paraService.createPregenWallet({
  pregenIdentifier: "user@example.com",
  pregenIdentifierType: "EMAIL"
});

// Store user share securely
await secureStorage.set(`user-share-${wallet.id}`, userShare);

// Restore user share when needed
await paraService.setUserShare({
  userShare: await secureStorage.get(`user-share-${walletId}`)
});
```

## Error Handling

The plugin implements comprehensive error handling following Eliza's patterns:

```typescript
try {
  await runtime.triggerAction("SIGN_PARA_TRANSACTION", params);
} catch (error) {
  if (error instanceof TransactionReviewDenied) {
    // Handle user denial
    console.log("User denied the transaction");
  } else if (error instanceof TransactionReviewTimeout) {
    // Handle timeout
    console.log("Transaction review timed out", error.transactionReviewUrl);
  } else {
    // Handle other errors
    console.error("Transaction error:", error);
  }
}
```

## Multi-Chain Support

The plugin supports a variety of EVM-compatible networks:

| Chain ID | Network |
|----------|---------|
| 1 | Ethereum Mainnet |
| 11155111 | Sepolia Testnet |
| 137 | Polygon |
| 42161 | Arbitrum |

Additional networks can be added by extending the chain configuration.

## Best Practices

1. **Security**
   - Store API keys securely in environment variables
   - Implement proper user authentication before wallet operations
   - Use secure storage for user shares
   - Follow Para's recommendations for session management

2. **Error Handling**
   - Implement proper error handling for all wallet operations
   - Handle transaction rejections and timeouts gracefully
   - Provide clear feedback to users when operations fail
   - Log errors appropriately for debugging

3. **Performance**
   - Keep track of session status to avoid unnecessary refreshes
   - Implement proper caching for wallet information
   - Use appropriate gas parameters for transactions
   - Handle network congestion scenarios with retry logic

4. **User Experience**
   - Guide users through the wallet creation process
   - Provide clear status updates during operations
   - Implement proper loading states during transaction signing
   - Give feedback on transaction progress and confirmations

## Contributing

We welcome contributions! Please see our Contributing Guide for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Related

- [Eliza Documentation](https://elizaos.github.io/eliza/)
- [Para Documentation](https://docs.getpara.com/)
- [Plugin Examples](https://github.com/elizaos/eliza/tree/main/examples/plugins)
- [Viem Documentation](https://viem.sh/)
