# @elizaos/plugin-raydium

A plugin for [ElizaOS](https://github.com/elizaos/eliza) that enables interaction with the Raydium DEX on Solana, including liquidity pool management, position tracking, and automated market making capabilities.

## Overview

The Raydium plugin provides comprehensive integration with Raydium's V2 SDK, allowing ElizaOS agents to:
- Manage concentrated liquidity positions (CLMM)
- Add and remove liquidity from pools
- Track and analyze LP positions
- Fetch pool information and statistics
- Execute swaps (coming soon)

## Features

- **Liquidity Pool Management**: Full support for adding and removing liquidity from Raydium pools
- **Position Tracking**: Monitor and analyze existing LP positions
- **Token2022 Support**: Compatible with Token2022 standard tokens
- **Mainnet & Devnet Support**: Configurable for both mainnet and devnet operations
- **TypeScript Native**: Fully typed for excellent developer experience
- **Comprehensive Testing**: Unit tests and E2E test scenarios included

## Installation

```bash
npm install @elizaos/plugin-raydium
```

## Configuration

### Environment Variables

Create a `.env` file in your project root:

```env
# Required
SOLANA_PRIVATE_KEY=your_base58_private_key
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# or use Helius RPC for better performance
HELIUS_RPC_URL=https://your-helius-rpc-url.com

# Optional
SOLANA_CLUSTER=mainnet # or devnet
```

### Plugin Registration

Register the plugin in your ElizaOS agent configuration:

```typescript
import { RaydiumPlugin } from '@elizaos/plugin-raydium';

const agent = new Agent({
  plugins: [RaydiumPlugin],
  // ... other configuration
});
```

## Usage

### Services

The plugin provides two main services:

#### RaydiumSdkService

Handles SDK initialization and connection management:

```typescript
const sdkService = runtime.getService('RaydiumSdkService');
await sdkService.load(ownerKeypair);
```

#### RaydiumLpService

Provides liquidity pool operations:

```typescript
const lpService = runtime.getService('RaydiumLpService');

// Get available pools
const pools = await lpService.getPools();

// Add liquidity
const result = await lpService.addLiquidity({
  userVault: ownerKeypair,
  poolId: '8sN9549P3Zn6xpQRqpApN57xzkCh6sJxLwuEjcG2W4Ji',
  tokenAAmountLamports: '1000000000', // 1 SOL
  slippageBps: 100, // 1%
});

// Get position details
const position = await lpService.getLpPositionDetails(
  owner.publicKey.toBase58(),
  positionNftMint
);

// Remove liquidity
const removeResult = await lpService.removeLiquidity({
  userVault: ownerKeypair,
  poolId: positionNftMint,
  lpTokenAmountLamports: position.liquidity,
  slippageBps: 100,
});
```

### Providers

#### positionProvider

Provides context about user's LP positions to the agent:

```typescript
const context = await positionProvider.get(runtime, message, state);
// Returns formatted information about all user positions
```

## API Reference

### ILpService Interface

The plugin implements the standard ElizaOS `ILpService` interface:

```typescript
interface ILpService {
  getDexName(): string;
  getPools(tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]>;
  addLiquidity(params: AddLiquidityParams): Promise<TransactionResult>;
  removeLiquidity(params: RemoveLiquidityParams): Promise<TransactionResult>;
  getLpPositionDetails(userPublicKey: string, poolId: string): Promise<LpPositionDetails | null>;
}
```

### Types

```typescript
interface AddLiquidityParams {
  userVault: Keypair;
  poolId: string;
  tokenAAmountLamports: string;
  tokenBAmountLamports?: string;
  slippageBps: number;
  tickLowerIndex?: number;
  tickUpperIndex?: number;
}

interface RemoveLiquidityParams {
  userVault: Keypair;
  poolId: string;
  lpTokenAmountLamports: string;
  slippageBps: number;
}
```

## Testing

The plugin includes comprehensive test coverage:

### Unit Tests

```bash
bun run test
```

### E2E Tests

E2E tests require a funded wallet on mainnet:

1. Set up your `.env` file with a private key
2. Ensure the wallet has SOL and any required tokens
3. Run the tests:

```bash
bun run test
```

## Example: SOL-ai16z Pool

The plugin has been tested with the SOL-ai16z pool:

- Pool ID: `8sN9549P3Zn6xpQRqpApN57xzkCh6sJxLwuEjcG2W4Ji`
- Token A: SOL
- Token B: ai16z (Token2022)

## Development

### Building

```bash
bun run build
```

### Running Tests

```bash
# Run all tests
bun run test

# Run only unit tests
bun run vitest

# Run with coverage
bun run test:coverage
```

### Project Structure

```
├── src/
│   ├── services/
│   │   ├── RaydiumSdkService.ts    # SDK initialization and management
│   │   └── RaydiumLpService.ts      # LP operations implementation
│   ├── providers/
│   │   └── positionProvider.ts      # Context provider for positions
│   ├── e2e/
│   │   ├── scenarios.ts             # E2E test scenarios
│   │   └── test-utils.ts            # Testing utilities
│   ├── types.ts                     # Type definitions
│   └── index.ts                     # Plugin entry point
├── tests/                           # Test files
├── docs.md                          # Detailed documentation
└── README.md                        # This file
```

## Troubleshooting

### Common Issues

1. **"Cannot find target token accounts"**: Ensure your wallet has the required tokens for the pool
2. **Empty pool list from API**: The plugin will fall back to RPC data when API is unavailable
3. **Token2022 compatibility**: Make sure to use pools that support Token2022 if trading those tokens

### Debug Mode

Enable debug logging:

```typescript
import { setLoggerLevel, LogLevel } from '@raydium-io/raydium-sdk-v2';
setLoggerLevel('Raydium', LogLevel.Debug);
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## Resources

- [Raydium SDK V2 Documentation](https://github.com/raydium-io/raydium-sdk-V2)
- [ElizaOS Documentation](https://github.com/elizaos/eliza)
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- Open an issue on GitHub
- Join the ElizaOS Discord community
- Check the [docs.md](./docs.md) file for detailed technical documentation
