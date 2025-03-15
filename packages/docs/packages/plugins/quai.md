# @elizaos/plugin-quai

Quai Network integration plugin for Eliza OS that enables native token transfers and interactions with the Quai blockchain.

## Overview

This plugin provides core functionality for interacting with the Quai Network, offering native token transfer capabilities and blockchain interactions through a simple interface.

## Features

- Native QUAI token transfers
- Multiple network support
- Secure transaction signing
- Comprehensive error handling
- Built-in address validation
- Automatic gas estimation
- Real-time transaction status

## Installation

```bash
pnpm install @elizaos/plugin-quai
```

## Configuration

The plugin requires the following environment variables:

```env
QUAI_PRIVATE_KEY=your-private-key
QUAI_RPC_URL=https://rpc.quai.network  # or your preferred RPC endpoint
```

## Usage

### Token Transfer

```typescript
import { quaiPlugin } from '@elizaos/plugin-quai';

// Send QUAI
const result = await eliza.execute({
  action: 'SEND_TOKEN',
  content: {
    recipient: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
    amount: '10'
  }
});
```

## API Reference

### Actions

#### `SEND_TOKEN`
Transfers QUAI tokens to another address.

```typescript
{
  action: 'SEND_TOKEN',
  content: {
    recipient: string,    // Recipient's Quai address (42 characters, 0x prefix)
    amount: string,       // Amount to send (in QUAI)
    tokenAddress?: string // Optional: for QRC20 tokens (not implemented yet)
  }
}
```

### Providers

The plugin uses Quai's native JsonRpcProvider for blockchain interactions:

```typescript
const provider = getQuaiProvider(runtime);
// Returns configured JsonRpcProvider instance
```

## Troubleshooting

### Common Issues

1. **Transaction Failures**
   - Check account balance
   - Verify recipient address format
   - Ensure sufficient gas
   - Confirm network connection

2. **Connection Problems**
   - Verify RPC endpoint
   - Check network status
   - Ensure valid credentials
   - Monitor API availability

3. **Configuration Issues**
   - Verify environment variables
   - Check address format
   - Confirm private key format
   - Validate RPC URL

## Security Best Practices

1. **Key Management**
   - Store private keys securely
   - Use environment variables
   - Never expose private keys in code
   - Monitor account activity

2. **Transaction Safety**
   - Validate all addresses
   - Implement amount validation
   - Double-check recipients
   - Monitor transaction status

3. **Error Handling**
   - Log all transaction attempts
   - Handle timeouts gracefully
   - Validate all user inputs
   - Provide clear error messages

## Testing

Run the test suite:

```bash
pnpm test
```

## Dependencies

- quais: ^1.0.0-alpha.25
- @elizaos/core: workspace:*

## Contributing

Contributions are welcome! Please ensure your code follows the existing patterns and includes appropriate tests.

## Credits

This plugin integrates with:
- [Quai Network](https://qu.ai/)
- [Quai JavaScript API](https://www.npmjs.com/package/quais)

For more information about Quai Network capabilities:
- [Quai Documentation](https://docs.qu.ai/)
- [Quai Network GitHub](https://github.com/dominant-strategies)

## License

This plugin is part of the Eliza project. See the main project repository for license information.