# NFT Collections Plugin

## Purpose

A powerful plugin for interacting with NFT collections, providing comprehensive market data, social analytics, and trading capabilities through various APIs including Reservoir, CoinGecko, and more.

## Key Features

- Real-time NFT collection data and market stats
- Floor prices, volume, and market cap tracking
- Collection activity monitoring
- Token-level data and attributes
- Collection statistics and rankings
- Market intelligence for 420+ verified collections
- Social analytics with sentiment analysis
- ML-powered price predictions
- GraphQL and WebSocket support

## Installation

```bash
bun add @elizaos/plugin-nft-collections
```

## Configuration

### Required:

```env
RESERVOIR_API_KEY=your-reservoir-api-key
```

### Optional:

```typescript
const plugin = new NFTCollectionsPlugin({
  caching: {
    enabled: true,
    ttl: 3600000, // 1 hour
    maxSize: 1000,
  },
  security: {
    rateLimit: {
      enabled: true,
      maxRequests: 100,
      windowMs: 60000,
    },
  },
  maxConcurrent: 5,
  maxRetries: 3,
  batchSize: 20,
});
```

## Integration

The plugin connects with ElizaOS through GraphQL, WebSocket real-time updates, and IPFS integration. It provides webhooks, ML-powered analytics, and supports authentication, security features, and trading agents.

## Example Usage

```typescript
// Get top collections with optimized batch processing
const collections = await nftService.getTopCollections();

// Get market intelligence with caching
const intelligence = await marketIntelligenceService.getMarketIntelligence('0x1234');

// Get social metrics with rate limiting
const metrics = await socialAnalyticsService.getSocialMetrics('0x1234');
```
