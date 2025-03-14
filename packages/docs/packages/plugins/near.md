# @elizaos/plugin-near

NEAR Protocol integration plugin for Eliza OS that enables token management, transfers, and swaps using Ref Finance.

## Overview

This plugin aims to be the basis of all interactions with the NEAR ecosystem, providing seamless integration with NEAR Protocol and Ref Finance DEX.

## Features

- NEAR token transfers
- Token swaps via Ref Finance
- Multiple network support (mainnet, testnet)
- Secure transaction signing
- Automatic storage deposit handling
- Real-time price feeds
- Portfolio tracking and management
- Smart routing for optimal swaps
- Built-in denomination handling
- Comprehensive error handling

## Installation

```bash
pnpm install @elizaos/plugin-near
```

## Configuration

The plugin requires environment variables or runtime settings:

```env
NEAR_WALLET_SECRET_KEY=your-wallet-private-key
NEAR_WALLET_PUBLIC_KEY=your-wallet-public-key
NEAR_ADDRESS=your-account.near
NEAR_NETWORK=testnet  # mainnet or testnet
NEAR_RPC_URL=https://neart.lava.build
NEAR_SLIPPAGE=0.01  # 1% slippage tolerance
```

## Usage

### Token Transfer

```typescript
import { nearPlugin } from "@elizaos/plugin-near";

// Send NEAR
const result = await eliza.execute({
    action: "SEND_NEAR",
    content: {
        recipient: "bob.near",
        amount: "1.5",
    },
});
```

### Token Swap

```typescript
const result = await eliza.execute({
    action: "EXECUTE_SWAP_NEAR",
    content: {
        inputTokenId: "wrap.near",
        outputTokenId: "token.v2.ref-finance.near",
        amount: "10",
    },
});
```

## API Reference

### Actions

#### `SEND_NEAR`

Transfers NEAR tokens to another account.

```typescript
{
  action: 'SEND_NEAR',
  content: {
    recipient: string,    // Recipient's NEAR account (e.g., "bob.near")
    amount: string,       // Amount to send (in NEAR)
    tokenAddress?: string // Optional: for NEP-141 tokens
  }
}
```

#### `EXECUTE_SWAP_NEAR`

Executes a token swap using Ref Finance.

```typescript
{
  action: 'EXECUTE_SWAP_NEAR',
  content: {
    inputTokenId: string,  // Input token contract (e.g., "wrap.near")
    outputTokenId: string, // Output token contract
    amount: string,        // Amount to swap
    slippageTolerance?: number // Optional: default from config
  }
}
```

### Providers

#### Wallet Provider

Provides wallet information and portfolio tracking.

```typescript
const walletInfo = await eliza.getProvider("wallet");
// Returns formatted portfolio including:
// - Account balance
// - Token balances
// - USD values
// - Market prices
```

## Troubleshooting

### Common Issues

1. **Transaction Failures**

    - Check account balance
    - Verify storage deposits
    - Ensure sufficient gas
    - Confirm slippage tolerance

2. **Connection Problems**

    - Verify RPC endpoint
    - Check network selection
    - Ensure valid credentials
    - Monitor API rate limits

3. **Swap Issues**
    - Verify token pairs exist
    - Check liquidity pools
    - Confirm price impact
    - Monitor slippage settings

## Security Best Practices

1. **Key Management**

    - Store private keys securely
    - Use environment variables
    - Implement key rotation
    - Monitor account activity

2. **Transaction Safety**

    - Validate all inputs
    - Implement amount limits
    - Double-check recipients
    - Monitor transaction status

3. **Network Security**

    - Use secure RPC endpoints
    - Implement retry mechanisms
    - Monitor for suspicious activity
    - Keep dependencies updated

4. **Error Handling**
    - Log all transaction attempts
    - Handle timeouts gracefully
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

- near-api-js: ^5.0.1
- @ref-finance/ref-sdk: ^1.4.6
- bignumber.js: ^9.1.2
- node-cache: ^5.1.2

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with:

- [NEAR Protocol](https://near.org/)
- [Ref Finance](https://ref.finance/)
- Official NEAR JavaScript API and SDKs

Special thanks to:

- The NEAR Protocol team for developing the NEAR blockchain
- The Ref Finance team for developing the Ref Finance DEX
- The Eliza community for their contributions and feedback.

For more information about NEAR blockchain capabilities:

- [NEAR Documentation](https://docs.near.org/)
- [NEAR Developer Portal](https://near.org/developers)
- [NEAR Network Dashboard](https://nearscan.io/)
- [NEAR GitHub Repository](https://github.com/nearprotocol/near-api-js)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
