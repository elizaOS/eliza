# @elizaos/plugin-multiversx

MultiversX blockchain integration plugin for Eliza OS that enables token management and transfers.

## Overview

This plugin aims to be the basis of all interactions with the MultiversX ecosystem.

## Features

- EGLD and ESDT token transfers
- Token creation and management
- Multiple network support (mainnet, devnet, testnet)
- Secure transaction signing
- Automatic nonce management
- Transaction status tracking
- Built-in denomination handling
- Comprehensive error handling

## Adding a new action

Reuse providers and utilities from the existing actions where possible. Add more utilities if you think they will be useful for other actions.

1. Add the action to the `actions` directory. Try to follow the naming convention of the other actions.
2. Export the action in the `index.ts` file.

## Installation

```bash
pnpm install @elizaos/plugin-multiversx
```

## Configuration

The plugin requires environment variables or runtime settings:

```env
MVX_PRIVATE_KEY=your-wallet-private-key
MVX_NETWORK=devnet  # mainnet, devnet, or testnet
ACCESS_TOKEN_MANAGEMENT_TO=everyone  # you can put an userid to limit token managament to one user only (use same id as in the database)
```

## Usage

### Token Transfer

```typescript
import { multiversxPlugin } from "@elizaos/plugin-multiversx";

// Send EGLD
const result = await eliza.execute({
    action: "SEND_TOKEN",
    content: {
        tokenAddress: "erd1...",
        amount: "1",
        tokenIdentifier: "EGLD",
    },
});

// Send ESDT
const result = await eliza.execute({
    action: "SEND_TOKEN",
    content: {
        tokenAddress: "erd1...",
        amount: "100",
        tokenIdentifier: "TEST-a1b2c3",
    },
});
```

### Token Creation

```typescript
const result = await eliza.execute({
    action: "CREATE_TOKEN",
    content: {
        tokenName: "TestToken",
        tokenTicker: "TEST",
        decimals: "18",
        amount: "1000000",
    },
});
```

### Token Swap

```typescript
const result = await eliza.execute({
    action: "SWAP",
    content: {
        tokenIn: "EGLD",
        amountIn: "1",
        tokenOut: "MEX"
    },
});
```

### Pool Creation

```typescript
const result = await eliza.execute({
    action: "CREATE_POOL",
    content: {
        baseTokenID: "KWAK",
        quoteTokenID: "EGLD",
        baseAmount: "1000000",
        quoteAmount: "20"
    },
});
```

## Troubleshooting

### Common Issues

1. **Transaction Failures**

    - Verify wallet has sufficient balance
    - Check network configuration matches intended network
    - Ensure correct token identifiers
    - Verify recipient address format

2. **Configuration Problems**

    - Validate private key format
    - Check network selection is valid
    - Ensure environment variables are properly set
    - Verify wallet permissions for token operations

3. **Token Creation Issues**

    - Check token name and ticker format
    - Verify EGLD balance for issuance fee
    - Ensure unique token identifiers
    - Monitor transaction status

4. **Network Connectivity**
    - Verify network endpoint availability
    - Check API rate limits
    - Monitor network status
    - Ensure proper network selection

## Security Best Practices

1. **Key Management**

    - Never expose private keys in code
    - Use environment variables for sensitive data
    - Implement key rotation policies
    - Monitor wallet activity

2. **Transaction Safety**

    - Validate all transaction parameters
    - Implement transaction limits
    - Use proper denomination handling
    - Double-check recipient addresses

3. **Network Security**

    - Use secure network connections
    - Implement retry mechanisms
    - Monitor for suspicious activity
    - Keep dependencies updated

4. **Error Handling**
    - Implement comprehensive error logging
    - Handle network timeouts gracefully
    - Validate all user inputs
    - Provide clear error messages

## Testing

Run the test suite:

```bash
pnpm test
```

Watch mode for development:

```bash
pnpm test:watch
```

## Dependencies

- @multiversx/sdk-core: ^13.15.0
- bignumber.js: ^9.1.2
- tsup: ^8.3.5
- vitest: ^2.1.5

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](https://github.com/elizaOS/eliza/blob/main/CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with the [MultiversX blockchain](https://multiversx.com/) using their official SDK.

Special thanks to:

- The MultiversX team for developing the MultiversX blockchain
- The Eliza community for their contributions and feedback.

For more information about MultiversX blockchain capabilities:

- [MultiversX Documentation](https://docs.multiversx.com/)
- [MultiversX Developer Portal](https://docs.multiversx.com/developers/getting-started/introduction)
- [MultiversX GitHub Repository](https://github.com/multiversx/mx-sdk-js)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
