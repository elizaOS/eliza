# Service Proxy Framework

Credit-based billing system for reselling third-party APIs.

## Philosophy

**Provider Abstraction > Provider Lock-in**

Routes should never know which provider they're using. This makes:
- Provider swaps trivial (hours not weeks)
- Multi-provider redundancy possible
- Cost optimization automatic
- LLM agents able to work without provider knowledge

## How It Works

Every service follows the same pattern:

```typescript
// 1. Define provider mapping (ONLY place that knows provider details)
const PROVIDER_PATHS = {
  methodName: "/provider/specific/path"
};

// 2. Configure service (auth, rate limits, caching, pricing)
export const serviceConfig: ServiceConfig = {
  id: "service-id",
  auth: "apiKeyWithOrg",
  rateLimit: { windowMs: 60_000, maxRequests: 100 },
  cache: { maxTTL: 30, hitCostMultiplier: 0.5 },
  getCost: async (body) => getServiceMethodCost("service-id", body.method)
};

// 3. Implement handler (translate generic method to provider call)
export const serviceHandler: ServiceHandler = async ({ body }) => {
  const { method, params } = body;
  const path = PROVIDER_PATHS[method];
  // ... call provider
};
```

Routes just call `executeWithBody()`:

```typescript
const body = { method: "getPrice", params: { address } };
return executeWithBody(serviceConfig, serviceHandler, request, body);
```

The engine handles:
- Authentication & authorization
- Credit reservation & billing
- Rate limiting
- Caching (with partial cost on hit)
- Usage tracking
- Retries & timeouts
- Error handling

## Services

### Solana RPC (`solana-rpc.ts`)

Resells Helius Solana RPC with 20% markup.

**Why Helius:**
- Industry-leading uptime (99.9%)
- DAS API (Digital Asset Standard) for compressed NFTs
- Enhanced APIs beyond standard Solana RPC

**Provider-agnostic design:**
- Method field matches Solana RPC spec
- Can swap to Quicknode/Alchemy by changing base URL
- Fallback URL support for redundancy

**Pricing:** CU-based, $0.01 per 10,000 CUs

### Market Data (`market-data.ts`)

Multi-chain token pricing and market data.

**Why Birdeye:**
- 10+ chain support (Solana, EVM, Sui)
- Real-time price feeds (<1s latency)
- Comprehensive data (price, volume, holders, security)

**Provider-agnostic design:**
- Methods like "getPrice" not "birdeyeGetPrice"
- PROVIDER_PATHS map is only coupling point
- Can switch to CoinGecko/DexScreener in <1 hour

**Pricing:** CU-based, $0.00001 per CU + 20% markup

### Unified RPC (`rpc.ts`)

Multi-chain JSON-RPC proxy for Solana and EVM chains.

**Why unified:**
- Standard RPC is a commodity (eth_*, Solana methods identical across providers)
- Single endpoint `/api/v1/rpc/[chain]` for all chains
- Provider swap = change one config, not 20 route files
- BD deals on standard RPC don't require code changes

**Architecture:**
- Provider registry maps chains to providers (Helius for Solana, Alchemy for EVM)
- `rpcConfigForChain(chain)` returns solanaRpcConfig for Solana, builds EVM config dynamically
- Batch support for both Solana and EVM (shared `calculateBatchCost` utility)
- Network selection via `?network=mainnet|testnet` query param

**Backward compatibility:**
- `/api/v1/solana/rpc` still works (delegates to unified handler)
- Returns identical responses via `rpcConfigForChain("solana")`
- No breaking changes

**Supported chains:**
- Solana (Helius): mainnet, devnet
- Ethereum, Polygon, Arbitrum, Optimism, Base, zkSync, Avalanche (Alchemy)

**Pricing:** CU-based per provider, 20% markup, separate `service_id` for commodity vs premium tiers

### Chain Data (`chain-data.ts`)

Enhanced blockchain data for EVM chains (NFTs, tokens, transfers).

**Why separate from standard RPC:**
- Enhanced APIs are 5-100x more expensive than standard RPC
- Provider-specific (not commodity like eth_getBalance)
- Higher margin justifies premium pricing
- BD deals on standard RPC don't affect enhanced pricing

**Dual-mode handler:**
- REST mode: Alchemy NFT API (GET requests)
- JSON-RPC mode: Alchemy Token/Transfers API (POST with alchemy_* methods)
- `buildRpcParams` transforms named params to positional (provider abstraction)

**Convenience routes:**
- `GET /api/v1/chain/nfts/[chain]/[address]` - getNFTsForOwner
- `GET /api/v1/chain/tokens/[chain]/[address]` - getTokenBalances
- `GET /api/v1/chain/transfers/[chain]/[address]` - getAssetTransfers

**Chain support:** EVM chains only (Solana has its own DAS-based convenience routes)

**Pricing:** Alchemy enhanced CU * $0.00000045 * 1.2, ranges from $0.000005 to $0.000259

## Adding a New Service

Let's add Twitter API as an example:

### 1. Create handler file

```typescript
// lib/services/proxy/services/twitter.ts

const PROVIDER_PATHS = {
  getTweet: "/2/tweets/:id",
  searchTweets: "/2/tweets/search/recent",
  getUser: "/2/users/:id"
};

export const twitterConfig: ServiceConfig = {
  id: "twitter",
  name: "Twitter API",
  auth: "apiKeyWithOrg",
  rateLimit: { windowMs: 60_000, maxRequests: 50 },
  cache: {
    maxTTL: 300,  // Tweets don't change, longer cache OK
    hitCostMultiplier: 0.5
  },
  getCost: async (body) => getServiceMethodCost("twitter", body.method)
};

export const twitterHandler: ServiceHandler = async ({ body }) => {
  const { method, params } = body;
  const path = PROVIDER_PATHS[method];

  const response = await retryFetch({
    url: `https://api.twitter.com${path}`,
    init: {
      method: "GET",
      headers: { "Authorization": `Bearer ${process.env.TWITTER_API_KEY}` }
    },
    // ... retry config
  });

  return { response };
};
```

### 2. Seed pricing

```sql
INSERT INTO service_pricing (service_id, method, cost)
VALUES
  ('twitter', '_default', 0.001),
  ('twitter', 'getTweet', 0.001),
  ('twitter', 'searchTweets', 0.005);  -- More expensive
```

### 3. Create routes

```typescript
// app/api/v1/twitter/tweet/[id]/route.ts
export async function GET(request, { params }) {
  const { id } = await params;

  const body = {
    method: "getTweet",
    params: { id }
  };

  return executeWithBody(twitterConfig, twitterHandler, request, body);
}
```

**Done.** Full credit billing, caching, rate limiting, and usage tracking work automatically.

## Design Decisions

### Why functional not class-based?

**Classes encourage large files:**
```typescript
class MarketDataService {
  private config: Config;
  private client: HttpClient;

  async getPrice() { }
  async getOHLCV() { }
  async getTrades() { }
  async getPortfolio() { }
  // ... grows to 500+ lines
}
```

**Functions encourage small modules:**
```typescript
// Each piece is independently testable and readable
const config = { /* 20 lines */ };
const handler = async () => { /* 30 lines */ };

// Routes import just what they need
import { config, handler } from "./market-data";
```

**Why this matters for LLMs:**
- Smaller files = fewer tokens to process
- Clear structure = easier to understand and modify
- Less coupling = changes are localized

### Why `method` field not REST paths?

**Option A: Pure REST**
```
GET /api/v1/market/price/solana/EPj...
GET /api/v1/market/ohlcv/solana/EPj...
GET /api/v1/market/trades/solana/EPj...
```

**Option B: Method field (chosen)**
```
Body: { method: "getPrice", chain: "solana", params: { address } }
Body: { method: "getOHLCV", chain: "solana", params: { address } }
Body: { method: "getTrades", chain: "solana", params: { address } }
```

**Why we chose B:**

1. **Provider agnostic**: Method names can match provider or be generic
2. **Extensible**: Add params without creating new routes
3. **Cacheable**: Engine reads `method` for cache decisions
4. **Consistent**: Same pattern across all services (Solana RPC uses this too)

**Trade-off:** Less RESTful, but more flexible and maintainable.

### Why DB-backed pricing?

**Alternative: Hardcoded**
```typescript
const PRICES = {
  getPrice: 0.00012,
  getOHLCV: 0.00048
};
```

**Why DB is better:**
- **Instant updates**: No deploy needed to change prices
- **Audit trail**: Track who changed prices and why
- **A/B testing**: Easy to test different price points
- **Per-org pricing**: Can offer discounts to high-volume customers

**Trade-off:** DB query latency, but we cache pricing in Redis (300s TTL).

### Why 20% markup?

**Provider costs are volatile:**
- Birdeye raised prices 15% in 2023
- Twitter API increased 300% in 2024
- OpenAI frequently adjusts pricing

**20% margin provides:**
- Buffer against provider price increases
- Covers platform costs (Redis, compute, support)
- Room for discounts to retain customers

**Industry comparison:**
- AWS charges 25-40% markup on compute
- Stripe charges 2.9% + $0.30 (effectively 50%+ markup for small transactions)
- Our 20% is competitive while sustainable

### Why 50% cost on cache hit?

**Options:**
- **0% cost**: Users abuse cache, spam requests
- **100% cost**: No incentive to use cache
- **50% cost**: Fair split of savings

**Math:**
```
Provider cost: $0.00012
Our price: $0.00012 × 1.2 = $0.000144

Cache miss: User pays $0.000144, we pay $0.00012 → $0.000024 margin
Cache hit:  User pays $0.000072, we pay $0        → $0.000072 margin

Win-win: User saves money, we increase margin
```

**Incentives:**
- Users set `Cache-Control: max-age=30` to save 50%
- Platform saves upstream API costs
- Higher cache hit rate = higher profits

## Security

### Input Validation

**Always validate before billing:**

```typescript
// Bad: Bill first, validate later
await creditsService.reserve(cost);
if (!isValid(input)) throw Error();  // Credits lost!

// Good: Validate first, then bill
if (!isValid(input)) throw Error();
await creditsService.reserve(cost);
```

**What to validate:**
1. Chain/network exists
2. Address format matches chain
3. Params are within bounds (limit ≤ 100)
4. Method is whitelisted (prevent arbitrary provider calls)

### API Key Security

**Never log API keys:**

```typescript
// Bad
logger.info(`Calling ${url}?api-key=${key}`);

// Good
const sanitized = url.replace(/api-key=[^&]+/, "api-key=***");
logger.info(`Calling ${sanitized}`);
```

The `retryFetch` utility does this automatically.

### Rate Limiting

**Why per-org not per-user:**
- Orgs pay for credits
- Prevents single user monopolizing quota
- Aligns with business model

**Why 100 req/min default:**
- Most providers offer 150-300 req/min free tier
- We reserve margin for retries and bursts
- Can increase per-org via pricing tiers

## Monitoring

Key metrics:

1. **Cache hit rate**: >70% is healthy
2. **Upstream latency**: P95 <500ms
3. **Error rate**: <1%
4. **Cost per request**: Provider cost vs our pricing
5. **Method distribution**: Which methods are popular

## Testing

```bash
# Unit tests (mock handler)
bun test lib/services/proxy/services/market-data.test.ts

# Integration tests (real provider)
MARKET_DATA_PROVIDER_API_KEY=test_xxx bun test tests/integration/market-data.test.ts
```

**Why integration tests matter:**
- Catch provider API changes
- Verify full request/response cycle
- Test retry logic under real network conditions

## Future Enhancements

1. **Multi-provider redundancy**
   ```typescript
   const providers = [birdeye, coingecko, dexscreener];
   for (const provider of providers) {
     try { return await provider.getPrice(); }
     catch (e) { continue; }  // Try next provider
   }
   ```

2. **Smart caching**
   - Longer TTL for stablecoins (price stable)
   - Shorter TTL for meme coins (high volatility)
   - Adaptive based on historical volatility

3. **Cost optimization**
   - Cache historical data permanently (OHLCV)
   - Batch requests to reduce per-item cost
   - Use cheaper providers for popular pairs

4. **Advanced features**
   - WebSocket streaming for real-time prices
   - GraphQL API for flexible queries
   - Webhooks for price alerts
