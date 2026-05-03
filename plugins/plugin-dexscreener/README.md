# @elizaos/plugin-dexscreener

A DexScreener integration plugin for ElizaOS that provides real-time DEX analytics, token information, and market data.

## Overview

The DexScreener plugin enables your ElizaOS agent to access comprehensive decentralized exchange (DEX) data across multiple blockchains. It provides real-time price information, trading volumes, liquidity data, and trending tokens through natural language interactions.

## Installation

```bash
npm install @elizaos/plugin-dexscreener
```

## Configuration

The plugin requires minimal configuration. Add these optional environment variables to customize behavior:

```env
# Optional: Custom API endpoint (defaults to https://api.dexscreener.com)
DEXSCREENER_API_URL=https://api.dexscreener.com

# Optional: Rate limit delay in milliseconds (defaults to 100)
DEXSCREENER_RATE_LIMIT_DELAY=100

# Optional: Skip real API tests in CI
SKIP_DEXSCREENER_API_TESTS=true
```

## Usage

Import and register the plugin in your ElizaOS configuration:

```typescript
import { dexscreenerPlugin } from "@elizaos/plugin-dexscreener";

const agent = new Agent({
  plugins: [dexscreenerPlugin],
  // ... other configuration
});
```

## Features

### 1. Token Search

Search for tokens and trading pairs across all supported DEXs and chains.

**Example prompts:**

- "Search for PEPE tokens"
- "Find USDC pairs on dexscreener"
- "Look for meme coins"

### 2. Token Information

Get detailed information about a specific token including price, volume, and liquidity.

**Example prompts:**

- "Get token info for 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
- "What is the price of token 0x..."
- "Show me details for [token address]"

### 3. Trending Tokens

Discover trending tokens based on various timeframes.

**Example prompts:**

- "Show me trending tokens"
- "What are the top 5 hot tokens in the last 6h?"
- "Show popular coins from the last 24h"

### 4. New Token Listings

Find newly created trading pairs and token launches.

**Example prompts:**

- "Show me new pairs"
- "What are the 5 new tokens on ethereum?"
- "Find latest token listings"

### 5. Chain-Specific Analytics

Get top tokens on specific blockchains sorted by various metrics.

**Example prompts:**

- "Show me top tokens on ethereum"
- "What are the most liquid pairs on polygon?"
- "Find highest volume tokens on base"

### 6. Boosted Tokens

Get information about promoted/boosted tokens on DexScreener.

**Example prompts:**

- "Show me boosted tokens"
- "What are the top promoted tokens?"
- "Find sponsored tokens"

### 7. Token Profiles

Access detailed token profile information including descriptions and social links.

**Example prompts:**

- "Show me latest token profiles"
- "Get token profile information"

## Supported Chains

The plugin supports all major chains available on DexScreener:

- Ethereum
- BSC (Binance Smart Chain)
- Polygon
- Arbitrum
- Optimism
- Base
- Solana
- Avalanche
- And many more...

## Actions

The plugin provides the following actions:

### dexscreener_search

Search for tokens/pairs across all DEXs and chains.

### dexscreener_token_info

Get detailed information about a specific token.

### dexscreener_trending

Get trending tokens based on timeframe (1h, 6h, 24h).

### dexscreener_new_pairs

Find newly created trading pairs.

### dexscreener_chain_pairs

Get top pairs on a specific blockchain.

### dexscreener_boosted_tokens

Get boosted/promoted tokens.

### dexscreener_token_profiles

Get latest token profiles with metadata.

## Service Methods

The DexScreenerService provides comprehensive API access:

### Core Methods

- `search(params)` - Search for tokens/pairs
- `getTokenPairs(params)` - Get pairs for a specific token
- `getPair(params)` - Get specific pair by address
- `getTrending(params)` - Get trending pairs
- `getPairsByChain(params)` - Get pairs by blockchain
- `getNewPairs(params)` - Get newly created pairs

### Additional Methods

- `getMultipleTokens(chainId, addresses)` - Get data for multiple tokens (max 30)
- `getTokenProfile(address)` - Get token profile information
- `getLatestTokenProfiles()` - Get latest token profiles
- `getLatestBoostedTokens()` - Get latest boosted tokens
- `getTopBoostedTokens()` - Get top boosted tokens
- `checkOrderStatus(chainId, address)` - Check token order status
- `getTokenPairsByChain(chainId, address)` - Get token pairs by chain

### Utility Methods

- `formatPrice(price)` - Format price with appropriate decimals
- `formatPriceChange(change)` - Format percentage change
- `formatUsdValue(value)` - Format USD values (K, M notation)

## Data Format

The plugin returns comprehensive market data including:

- **Price Information**: Current price in USD and native tokens
- **Price Changes**: 5m, 1h, 6h, and 24h percentage changes
- **Volume Data**: Trading volume across multiple timeframes
- **Liquidity**: Total liquidity in USD and token amounts
- **Transaction Counts**: Buy/sell transaction counts
- **Market Metrics**: Market cap, fully diluted valuation (FDV)
- **Pair Details**: DEX, chain, token addresses, and creation time
- **Token Profiles**: Icons, descriptions, social links
- **Boost Information**: Boost amounts and rankings

## Development

### Building

```bash
npm run build
```

### Testing

```bash
# Run all tests
npm test

# Run with watch mode
npm run test:watch

# Run only unit tests
npm run test:unit

# Run real API tests (requires internet connection)
SKIP_DEXSCREENER_API_TESTS=false npm test
```

### Test Structure

The plugin includes comprehensive test coverage:

- **Unit Tests** (`src/__tests__/service.test.ts`, `src/__tests__/actions.test.ts`): Test individual methods with mocked API responses
- **E2E Tests** (`src/__tests__/e2e.test.ts`): Test plugin integration and action execution
- **Real API Tests** (`src/__tests__/e2e-real.test.ts`): Test against live DexScreener API (optional)

### Project Structure

```
plugin-dexscreener/
├── src/
│   ├── index.ts       # Plugin definition and exports
│   ├── service.ts     # DexScreenerService implementation
│   ├── actions.ts     # Action definitions
│   ├── types.ts       # TypeScript interfaces
│   └── __tests__/     # Test files
│       ├── service.test.ts    # Service unit tests
│       ├── actions.test.ts    # Action unit tests
│       ├── e2e.test.ts        # E2E integration tests
│       └── e2e-real.test.ts   # Real API tests
├── package.json
├── tsconfig.json
└── README.md
```

## API Rate Limiting

The plugin implements automatic rate limiting to comply with DexScreener API requirements:

- Default delay between requests: 100ms
- Configurable via `DEXSCREENER_RATE_LIMIT_DELAY` environment variable
- Rate limits:
  - 300 requests/minute for most endpoints
  - 60 requests/minute for profile and boost endpoints

## Error Handling

The plugin gracefully handles various error scenarios:

- Invalid token addresses
- API rate limits
- Network timeouts
- Missing data
- Non-existent pairs

All errors are returned with descriptive messages to help users understand what went wrong.

## Real-World Usage Examples

### Get comprehensive token analysis

```typescript
const service = runtime.getService("dexscreener") as DexScreenerService;

// Get token pairs
const pairs = await service.getTokenPairs({
  tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
});

// Get token profile
const profile = await service.getTokenProfile(
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
);

// Check if token is boosted
const boosted = await service.getTopBoostedTokens();
```

### Monitor new token launches

```typescript
// Get new pairs on a specific chain
const newPairs = await service.getNewPairs({
  chain: "ethereum",
  limit: 10,
});

// Filter by creation time
const recentPairs = newPairs.data.filter(
  (pair) => pair.pairCreatedAt > Date.now() - 3600000 // Last hour
);
```

## Contributing

Contributions are welcome! Please ensure all tests pass and add new tests for any new functionality.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- All new methods should include unit tests
- Real API tests should be added for new endpoints
- Update types in `types.ts` for new data structures
- Add new actions for user-facing features
- Update this README with new features

## License

This plugin is part of the ElizaOS project and is licensed under the MIT License.

## Support

For issues and questions:

- Open an issue on GitHub
- Check the ElizaOS documentation
- Join the ElizaOS community Discord

## Acknowledgments

This plugin integrates with [DexScreener](https://dexscreener.com/), the leading real-time DEX analytics platform.
