# @elizaos/plugin-viction

Core Viction blockchain plugin for Eliza OS that provides essential services and actions for token operations, trading, and DeFi integrations.

## Overview

The Viction plugin serves as a foundational component of Eliza OS, bridging Viction blockchain capabilities with the Eliza ecosystem. It provides crucial services for token operations, trading, portfolio management, and DeFi integrations, enabling both automated and user-directed interactions with the Viction blockchain.

## Features

### Token Operations
- **Token Information**: Provide Viction information
- **Token Transfers**: Send and receive tokens securely native and non-native

## Installation

```bash
npm install @elizaos/plugin-viction
```

## Configuration

Configure the plugin by setting the following environment variables:

```typescript
const victionEnvSchema = {
    VICTION_ADDRESS: string,
    VICTION_PRIVATE_KEY: string,
    VICTION_RPC_URL: string
};
```

## Usage

### Basic Setup

```typescript
import { victionPlugin } from "@elizaos/plugin-viction";

// Initialize the plugin
const runtime = await initializeRuntime({
    plugins: [victionPlugin],
});
```

## Actions

### vic_infomations

Provide Viction's information

```typescript
// Example usage
const result = await runtime.executeAction("GIVE_VICTION_INFOMATION", {});
```

### transferVic

Transfers VIC between wallets.

```typescript
// Example usage
const result = await runtime.executeAction("SEND_VIC", {
    recipient: "RecipientAddressHere",
    amount: "1000",
});
```
### transferTokens

Transfers tokens between wallets.

```typescript
// Example usage
const result = await runtime.executeAction("SEND_TOKEN", {
    recipient: "RecipientAddressHere",
    tokenAddress: "TokenAddressHere"
    amount: "1000",
});
```
## Performance Optimization

1. **Cache Management**

    - Implement token data caching
    - Configure cache TTL settings
    - Monitor cache hit rates

2. **RPC Optimization**

    - Use connection pooling
    - Implement request batching
    - Monitor RPC usage

3. **Transaction Management**
    - Optimize transaction bundling
    - Implement retry strategies
    - Monitor transaction success rates

## System Requirements

- Node.js 16.x or higher
- Minimum 4GB RAM recommended
- Stable internet connection
- Access to Viction RPC endpoint

## Troubleshooting

### Common Issues

1. **Wallet Connection Failures**

```bash
Error: Failed to connect to wallet
```

- Verify RPC endpoint is accessible
- Check wallet configuration settings
- Ensure proper network selection

2. **Transaction Errors**

```bash
Error: Transaction failed
```

- Check account balances
- Verify transaction parameters
- Ensure proper fee configuration


## Safety & Security

### Best Practices

1. **Environment Variables**

    - Store sensitive keys in environment variables
    - Use .env.example for non-sensitive defaults
    - Never commit real credentials to version control

## Performance Optimization

1. **Cache Management**

    - Implement token data caching
    - Configure cache TTL settings
    - Monitor cache hit rates

2. **RPC Optimization**

    - Use connection pooling
    - Implement request batching
    - Monitor RPC usage

3. **Transaction Management**
    - Optimize transaction bundling
    - Implement retry strategies
    - Monitor transaction success rates

## Support

For issues and feature requests, please:

1. Check the troubleshooting guide above
2. Review existing GitHub issues
3. Submit a new issue with:
    - System information
    - Error logs
    - Steps to reproduce
    - Transaction IDs (if applicable)

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## License

This plugin is part of the Eliza project. See the main project repository for license information.
