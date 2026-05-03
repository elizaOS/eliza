# @elizaos/plugin-meteora

A plugin for [ElizaOS](https://github.com/elizaos/eliza) that enables interaction with the [Meteora](https://meteora.ag/) decentralized exchange (DEX) on Solana. This plugin provides comprehensive liquidity pool management capabilities including pool discovery, liquidity provision, position tracking, and market data retrieval.

## Features

- 🔍 **Pool Discovery**: Search and filter Meteora liquidity pools
- 💧 **Liquidity Management**: Add and remove liquidity from pools
- 📊 **Position Tracking**: Monitor LP positions and their performance
- 📈 **Market Data**: Retrieve real-time pool statistics (APY, TVL)
- 🤖 **AI Integration**: Seamless integration with ElizaOS agents for automated LP management

## Installation

```bash
npm install @elizaos/plugin-meteora
```

## Configuration

The plugin requires the following environment variables:

```env
# Required for mainnet operations
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Required for transaction signing
SOLANA_PRIVATE_KEY=your_base58_encoded_private_key
# or
WALLET_PRIVATE_KEY=your_base58_encoded_private_key

# Required for read-only operations
SOLANA_PUBLIC_KEY=your_public_key_address
# or
WALLET_PUBLIC_KEY=your_public_key_address
```

## Usage

### Basic Integration

```typescript
import meteoraPlugin from '@elizaos/plugin-meteora';

// Register the plugin with your ElizaOS agent
const agent = new Agent({
  plugins: [meteoraPlugin],
  // ... other configuration
});
```

### Service API

The plugin provides a `MeteoraLpService` that can be accessed within your agent:

```typescript
const meteoraService = runtime.getService('meteora-lp');

// Get all pools
const pools = await meteoraService.getPools();

// Filter pools by token pair
const solUsdcPools = await meteoraService.getPools(
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  // USDC
);

// Get market data
const marketData = await meteoraService.getMarketDataForPools([poolId]);

// Add liquidity
const result = await meteoraService.addLiquidity({
  userVault: keypair,
  poolId: 'pool_address',
  tokenAAmountLamports: '1000000000', // 1 SOL
  tokenBAmountLamports: '1000000',    // 1 USDC (optional)
  slippageBps: 100,                   // 1%
});

// Remove liquidity
const removeResult = await meteoraService.removeLiquidity({
  userVault: keypair,
  poolId: 'pool_address',
  lpTokenAmountLamports: '1000000',
  slippageBps: 100,
});

// Get position details
const position = await meteoraService.getLpPositionDetails(
  userPublicKey,
  poolOrPositionIdentifier
);
```

### Position Provider

The plugin includes a position provider that supplies context about the user's Meteora LP positions:

```typescript
// The provider is automatically registered and will provide context like:
{
  data: {
    positions: [...],
    positionCount: 2,
    inRangeCount: 1
  },
  values: {
    positionCount: 2,
    hasPositions: true,
    inRangeCount: 1
  },
  text: "Found 2 Meteora LP positions. 1 is currently in range..."
}
```

## API Reference

### MeteoraLpService

#### `getDexName(): string`
Returns the DEX identifier (`'meteora'`).

#### `getPools(tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]>`
Fetches all Meteora pools or filters by token pair.

#### `addLiquidity(params: AddLiquidityParams): Promise<TransactionResult>`
Adds liquidity to a pool using DLMM (Dynamic Liquidity Market Maker) strategy.

Parameters:
- `userVault`: Keypair for signing transactions
- `poolId`: The pool address
- `tokenAAmountLamports`: Amount of token A in lamports
- `tokenBAmountLamports?`: Amount of token B (optional, auto-calculated if not provided)
- `slippageBps`: Slippage tolerance in basis points

#### `removeLiquidity(params: RemoveLiquidityParams): Promise<TransactionResult>`
Removes liquidity from a position.

Parameters:
- `userVault`: Keypair for signing transactions
- `poolId`: The pool address
- `lpTokenAmountLamports`: LP token amount to remove
- `slippageBps`: Slippage tolerance in basis points

#### `getLpPositionDetails(userAccount: string, poolOrPosition: string): Promise<LpPositionDetails | null>`
Retrieves detailed information about an LP position.

#### `getMarketDataForPools(poolIds: string[]): Promise<Record<string, PoolMarketData>>`
Fetches market data (APY, TVL) for specified pools.

## Testing

The plugin includes comprehensive test coverage:

### Unit Tests

```bash
# Run unit tests
bun test src/services/__tests__
```

### E2E Tests

```bash
# Run full test suite including E2E scenarios
bun run test
```

The E2E test suite includes 10 scenarios covering:
- Pool discovery and filtering
- Market data retrieval
- Position management
- Error handling
- Full workflow integration

## Project Structure

```
plugin-meteora/
├── src/
│   ├── index.ts              # Plugin entry point
│   ├── services/
│   │   └── MeteoraLpService.ts    # Main service implementation
│   ├── providers/
│   │   └── positionProvider.ts    # Position context provider
│   ├── utils/
│   │   ├── dlmm.ts               # DLMM integration utilities
│   │   ├── loadWallet.ts         # Wallet loading helpers
│   │   └── sendTransaction.ts    # Transaction utilities
│   └── e2e/
│       ├── scenarios.ts          # E2E test scenarios
│       └── test-utils.ts         # Test utilities
├── tsconfig.json
├── package.json
└── README.md
```

## Dependencies

- `@coral-xyz/anchor`: Anchor framework for Solana
- `@meteora-ag/dlmm`: Meteora's DLMM SDK
- `@solana/web3.js`: Solana Web3 SDK
- `@elizaos/core`: ElizaOS core framework

## Error Handling

The plugin implements robust error handling:
- Invalid pool IDs return descriptive error messages
- Network failures are caught and logged
- Missing positions return null instead of throwing
- All service methods return success/error status

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow ElizaOS plugin architecture standards
- Add unit tests for new functionality
- Update E2E scenarios for significant features
- Ensure all tests pass before submitting PR
- Use TypeScript strict mode

## License

This plugin is part of the ElizaOS ecosystem. See the main [ElizaOS repository](https://github.com/elizaos/eliza) for license information.

## Support

- 📚 [ElizaOS Documentation](https://docs.eliza.gg)
- 💬 [Discord Community](https://discord.gg/elizaos)
- 🐛 [Issue Tracker](https://github.com/elizaos/eliza/issues)

## Acknowledgments

Built with ❤️ by the ElizaOS community for seamless DeFi automation on Solana. 