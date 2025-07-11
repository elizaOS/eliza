# @elizaos/plugin-near

A comprehensive NEAR Protocol plugin for ElizaOS that enables token transfers, swaps via Ref Finance, and full wallet management.

## Features

- 🚀 **Native NEAR transfers** - Send NEAR tokens to any account
- 💱 **Token swaps** - Swap any NEP-141 tokens using Ref Finance
- 👛 **Wallet management** - Check balances and manage multiple tokens
- 🔄 **Automatic retries** - Built-in retry logic for failed transactions
- 🛡️ **Type-safe** - Full TypeScript support with comprehensive types
- 🧪 **Well-tested** - Extensive test coverage for all functionality
- 📊 **Service architecture** - Modular services for easy extension

## Installation

```bash
npm install @elizaos/plugin-near
```

## Configuration

The plugin requires the following environment variables:

```bash
# Required
NEAR_WALLET_SECRET_KEY=ed25519:your-secret-key
NEAR_WALLET_PUBLIC_KEY=ed25519:your-public-key
NEAR_ADDRESS=your-account.near

# Optional (defaults shown)
NEAR_NETWORK=testnet           # or 'mainnet'
NEAR_RPC_URL=https://neart.lava.build
NEAR_SLIPPAGE=1               # 1% default slippage for swaps
```

## Usage

### Basic Setup

```typescript
import { nearPlugin } from '@elizaos/plugin-near';
import { createAgent } from '@elizaos/core';

const agent = createAgent({
  plugins: [nearPlugin],
  // ... other configuration
});
```

### Available Actions

#### Transfer NEAR

```typescript
// Natural language
'Send 10 NEAR to alice.near';
'Transfer 5.5 NEAR to bob.near';

// With tokens
'Send 100 USDC to charlie.near';
'Transfer 50 REF tokens to dave.near';
```

#### Swap Tokens

```typescript
// Simple swaps
'Swap 10 NEAR for USDC';
'Exchange 100 USDC for REF tokens';
'Trade 50 REF for NEAR';

// The agent will:
// 1. Get a quote with price impact
// 2. Warn if slippage is high
// 3. Execute the swap via Ref Finance
```

### Services

The plugin provides three main services:

#### WalletService

Manages NEAR wallet connections and basic operations:

```typescript
const walletService = runtime.getService('near-wallet');

// Get wallet info
const info = await walletService.getWalletInfo();
console.log(info.balance); // NEAR balance in yocto
console.log(info.tokens); // Array of token balances

// Check if account has enough balance
const hasBalance = await walletService.hasEnoughBalance(amount, includeGas);
```

#### TransactionService

Handles all transaction building and execution:

```typescript
const txService = runtime.getService('near-transaction');

// Send NEAR
const result = await txService.sendNear({
  recipient: 'alice.near',
  amount: '10', // in NEAR
});

// Send tokens
const tokenResult = await txService.sendToken({
  recipient: 'bob.near',
  amount: '100',
  tokenId: 'usdc.fakes.testnet',
});
```

#### SwapService

Manages token swaps via Ref Finance:

```typescript
const swapService = runtime.getService('near-swap');

// Get swap quote
const quote = await swapService.getQuote({
  inputTokenId: 'wrap.near',
  outputTokenId: 'usdc.fakes.testnet',
  amount: '1000000000000000000000000', // 1 NEAR in yocto
});

// Execute swap
const swapResult = await swapService.executeSwap({
  inputTokenId: 'wrap.near',
  outputTokenId: 'usdc.fakes.testnet',
  amount: '1000000000000000000000000',
});
```

## Error Handling

The plugin includes comprehensive error handling with specific error codes:

```typescript
import { NearPluginError, NearErrorCode } from '@elizaos/plugin-near';

try {
  await txService.sendNear(params);
} catch (error) {
  if (error instanceof NearPluginError) {
    switch (error.code) {
      case NearErrorCode.INSUFFICIENT_BALANCE:
        console.log('Not enough balance');
        break;
      case NearErrorCode.ACCOUNT_NOT_FOUND:
        console.log('Account does not exist');
        break;
      case NearErrorCode.SLIPPAGE_EXCEEDED:
        console.log('Price changed too much');
        break;
      // ... handle other errors
    }
  }
}
```

## Advanced Features

### Custom Slippage

Set custom slippage tolerance for swaps:

```typescript
const swapResult = await swapService.executeSwap({
  inputTokenId: 'wrap.near',
  outputTokenId: 'usdc.fakes.testnet',
  amount: '1000000000000000000000000',
  slippageTolerance: 0.05, // 5% slippage
});
```

### Storage Deposits

The plugin automatically handles storage deposits for NEP-141 tokens. When sending tokens to an account for the first time, it will:

1. Check if the recipient has storage deposit
2. Add storage deposit transaction if needed
3. Execute the transfer

### Price Impact Protection

Swaps automatically check price impact and warn users when it exceeds 5%:

```
Warning: This swap has high price impact (8.5%).
You'll receive approximately 92 USDC.
Would you like to proceed?
```

### Explorer Integration

All transactions include explorer URLs for easy verification:

```typescript
const result = await txService.sendNear(params);
console.log(`View transaction: ${result.explorerUrl}`);
// https://explorer.testnet.near.org/transactions/4jK3x...
```

## Development

### Building

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

### Testing

The plugin includes comprehensive tests for all services and actions:

```bash
# Run all tests
npm test

# Run specific test file
npm test src/__tests__/plugin.test.ts

# Run with watch mode
npm test -- --watch
```

## Network Support

The plugin supports both mainnet and testnet:

### Testnet (default)

- RPC: https://neart.lava.build
- Explorer: https://explorer.testnet.near.org
- Ref Finance: ref-finance-101.testnet

### Mainnet

- RPC: https://near.lava.build
- Explorer: https://explorer.near.org
- Ref Finance: v2.ref-finance.near

## Common Token Addresses

### Mainnet

- wNEAR: `wrap.near`
- USDT: `dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near`
- USDC: `a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near`
- DAI: `6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near`
- REF: `token.v2.ref-finance.near`

### Testnet

- wNEAR: `wrap.testnet`
- USDT: `usdt.fakes.testnet`
- USDC: `usdc.fakes.testnet`
- DAI: `dai.fakes.testnet`
- REF: `ref.fakes.testnet`

## Troubleshooting

### "Account not found" error

- Ensure the NEAR account exists on the network you're using
- Check that you're on the correct network (mainnet vs testnet)

### "Insufficient balance" error

- The plugin reserves 0.1 NEAR for storage and gas
- Ensure you have enough balance including gas fees

### "No swap route found" error

- The token pair might not have liquidity on Ref Finance
- Try swapping through wNEAR as an intermediate token

### Transaction failures

- Check the explorer URL for detailed error messages
- Ensure your account has valid access keys
- Verify the recipient account exists

## Contributing

Contributions are welcome! Please ensure:

1. All tests pass
2. Coverage remains above 80%
3. Code follows the existing style
4. New features include tests
5. Documentation is updated

## License

MIT
