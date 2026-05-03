# @elizaos/plugin-lpinfo

A comprehensive liquidity pool information plugin for ElizaOS agents. This plugin provides unified access to multiple DeFi liquidity pool protocols on Solana, including Steer Finance and Kamino Protocol.

## Features

### Steer Finance Integration

- **Vault Management**: Access and track Steer Finance vaults across multiple chains
- **Staking Pools**: Monitor staking positions and rewards
- **Market Analytics**: Real-time vault statistics and performance metrics
- **Multi-Chain Support**: Track liquidity positions across different blockchains

### Kamino Protocol Integration

- **Lending Positions**: View and analyze Kamino lending protocol positions
- **Liquidity Pools**: Track liquidity pool positions and performance
- **Market Analytics**: Comprehensive market data and statistics
- **Yield Optimization**: Analytics for maximizing yield across positions

## Installation

```bash
bun add @elizaos/plugin-lpinfo
```

## Configuration

### Environment Variables

The plugin works out of the box with Solana RPC connections. No API keys required for basic functionality.

### Plugin Registration

Register the plugin in your agent configuration:

```typescript
import { lpinfoPlugin } from '@elizaos/plugin-lpinfo';

const agent = {
  // ... other config
  plugins: [lpinfoPlugin],
};
```

## Usage

### As Providers

The plugin automatically provides liquidity pool information through dynamic providers:

#### Steer Finance Provider

- **Name**: `STEER_LIQUIDITY`
- **Dynamic**: Yes
- **Purpose**: Provides Steer Finance vault and staking information

#### Kamino Protocol Providers

- **Kamino Main**: General Kamino protocol information
- **Kamino Liquidity**: Liquidity pool positions and analytics
- **Kamino Pool**: Detailed pool statistics and market data

### Direct Service Usage

You can also use the services directly in your actions:

```typescript
// Steer Finance
const steerService = runtime.getService('STEER_LIQUIDITY_SERVICE');
const vaults = await steerService.getVaults();

// Kamino Protocol
const kaminoService = runtime.getService('KAMINO_SERVICE');
const markets = await kaminoService.getMarkets();

const kaminoLiquidityService = runtime.getService('KAMINO_LIQUIDITY_SERVICE');
const positions = await kaminoLiquidityService.getUserPositions(walletAddress);
```

## Architecture

### Steer Finance Components

```
steer/
├── providers/
│   └── steerLiquidityProvider.ts  # Vault and staking data provider
├── services/
│   └── steerLiquidityService.ts   # Steer Finance SDK integration
├── index.ts                        # Steer plugin definition
└── README.md                       # Steer-specific documentation
```

### Kamino Protocol Components

```
kamino/
├── providers/
│   ├── kaminoProvider.ts           # Main Kamino provider
│   ├── kaminoLiquidityProvider.ts  # Liquidity positions provider
│   └── kaminoPoolProvider.ts       # Pool analytics provider
├── services/
│   ├── kaminoService.ts            # Kamino SDK integration
│   └── kaminoLiquidityService.ts   # Liquidity management service
└── index.ts                         # Kamino plugin definition
```

## API Reference

### Steer Finance Service

#### `SteerLiquidityService`

- `getVaults()`: Get all Steer Finance vaults
- `getVaultById(vaultId)`: Get specific vault details
- `getUserPositions(walletAddress)`: Get user's vault positions
- `getStakingPools()`: Get available staking pools
- `getVaultPerformance(vaultId)`: Get vault performance metrics

### Kamino Services

#### `KaminoService`

- `getMarkets()`: Get all Kamino markets
- `getMarketData(marketId)`: Get specific market data
- `getUserObligations(walletAddress)`: Get user's lending obligations

#### `KaminoLiquidityService`

- `getUserPositions(walletAddress)`: Get user's liquidity positions
- `getPoolInfo(poolAddress)`: Get detailed pool information
- `calculateYield(positionId)`: Calculate position yield

## Provider Data Structure

### Steer Finance Provider

```typescript
{
  data: {
    vaults: Array<{
      vaultId: string;
      name: string;
      tvl: number;
      apy: number;
      chain: string;
    }>;
    stakingPools: Array<{
      poolId: string;
      name: string;
      stakedAmount: number;
      rewards: number;
    }>;
  },
  values: {
    totalTVL: number;
    totalVaults: number;
    averageAPY: number;
  },
  text: string  // Formatted summary
}
```

### Kamino Protocol Providers

```typescript
{
  data: {
    markets: Array<{
      marketId: string;
      name: string;
      totalSupply: number;
      totalBorrow: number;
      utilizationRate: number;
    }>;
    positions: Array<{
      positionId: string;
      poolAddress: string;
      liquidity: number;
      value: number;
    }>;
  },
  values: {
    totalValueLocked: number;
    totalPositions: number;
    totalYield: number;
  },
  text: string  // Formatted summary
}
```

## Development

### Build

```bash
bun run build
```

### Development Mode

```bash
bun run dev
```

### Clean Build Artifacts

```bash
bun run clean
```

## Testing

The plugin includes comprehensive test suites for both Steer Finance and Kamino Protocol integrations:

```bash
# Run all tests
bun test

# Test Steer Finance
bun test steer

# Test Kamino Protocol
bun test kamino
```

## Dependencies

- `@steerprotocol/sdk`: Steer Finance protocol SDK
- `@kamino-finance/kliquidity-sdk`: Kamino liquidity SDK
- `@kamino-finance/klend-sdk`: Kamino lending SDK
- `@solana/web3.js`: Solana blockchain interactions
- `@coral-xyz/anchor`: Solana program framework

## Supported Chains

### Steer Finance
- Ethereum
- Polygon
- Arbitrum
- Optimism
- Base
- And more...

### Kamino Protocol
- Solana (mainnet)

## Error Handling

The plugin includes comprehensive error handling:

- Graceful degradation when services are unavailable
- Retry logic for network failures
- Detailed error logging for debugging
- User-friendly error messages

## Performance Optimizations

- **Caching**: Intelligent caching of market data and pool information
- **Batch Requests**: Optimized batch fetching for multiple positions
- **Lazy Loading**: Services initialized only when needed
- **Connection Pooling**: Efficient RPC connection management

## Best Practices

1. **Service Availability**: Always check if services are available before using them
2. **Error Handling**: Wrap service calls in try-catch blocks
3. **Rate Limiting**: Be mindful of RPC rate limits for public endpoints
4. **Data Freshness**: Consider cache duration for time-sensitive operations

## Troubleshooting

### Common Issues

1. **"Service not found"**
   - Ensure the plugin is loaded in your agent configuration
   - Check that service initialization completed successfully

2. **RPC Connection Errors**
   - Verify Solana RPC endpoint is accessible
   - Check network connectivity
   - Consider using a paid RPC provider for better reliability

3. **Missing Position Data**
   - Verify wallet address is correct
   - Ensure wallet has actual positions in the protocol
   - Check if the protocol is supported on the current network

## Contributing

Contributions are welcome! Please ensure:
- All tests pass
- Code follows project style guidelines
- Documentation is updated
- Changes are backward compatible

## License

MIT

## Support

For issues and questions:
- GitHub Issues: [elizaos-plugins/plugin-lpinfo](https://github.com/elizaos-plugins/plugin-lpinfo)
- Steer Finance Docs: [docs.steer.finance](https://docs.steer.finance)
- Kamino Docs: [docs.kamino.finance](https://docs.kamino.finance)

## Acknowledgments

Built for the ElizaOS ecosystem. Powered by Steer Finance and Kamino Protocol.

