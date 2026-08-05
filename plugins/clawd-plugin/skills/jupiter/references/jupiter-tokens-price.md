# Jupiter Tokens & Price APIs

## What This Covers

Token discovery, metadata, and pricing via Jupiter's Tokens and Price APIs — searching for tokens, verifying legitimacy, and getting real-time prices.

---

## Tokens API (v2)

### Base URL & Auth

```
Base: https://api.jup.ag/tokens/v2
Auth: x-api-key header (required)
```

### GET /search — Search Tokens

Search for tokens by name, symbol, or mint address:

```typescript
const response = await fetch(
  `https://api.jup.ag/tokens/v2/search?query=bonk`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const tokens = await response.json();
// Returns array of matching tokens with metadata
```

Each token result includes:
- `id` — Mint address
- `name` — Token name
- `symbol` — Token symbol
- `decimals` — Decimal places
- `icon` — Token logo URL
- `isVerified` — Whether the token is verified
- `organicScore` — Trading activity and community validation score
- `mcap` — Market capitalization
- `usdPrice` — Current USD price
- `liquidity` — Available liquidity

### Looking Up Tokens by Mint

To look up specific tokens, use search with comma-separated mint addresses (up to 100):

```typescript
const mints = 'So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const response = await fetch(
  `https://api.jup.ag/tokens/v2/search?query=${mints}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);
```

### Token Verification & Organic Score

Jupiter assigns tokens an **organic score** based on trading activity and community validation. Use this to filter out low-quality or potentially malicious tokens:

```typescript
// Filter for verified tokens only
const verifiedTokens = tokens.filter(t => t.isVerified);
```

**Best practice**: Always verify tokens before displaying them in a UI. Show verification status to users.

---

## Price API (v3)

### Base URL & Auth

```
Base: https://api.jup.ag/price/v3
Auth: x-api-key header (required)
```

### GET /price — Get Token Prices

```typescript
const mints = [
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
].join(',');

const response = await fetch(
  `https://api.jup.ag/price/v3?ids=${mints}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const prices = await response.json();
// Returns mint addresses at the TOP LEVEL (no `data` wrapper):
// {
//   "So11111111111111111111111111111111111111112": {
//     "usdPrice": 82.04,
//     "blockId": 412733640,
//     "decimals": 9,
//     "priceChange24h": -2.61
//   },
//   ...
// }
```

**Constraints**:
- Maximum **50 mint IDs** per request
- Prices are in USD

### Response Fields

Mints are keyed at the top level — there is NO `data` wrapper and NO `id` field on each entry.

```typescript
const solPrice = prices['So11111111111111111111111111111111111111112'];
console.log(`SOL: $${solPrice.usdPrice}`);
console.log(`24h change: ${solPrice.priceChange24h}%`);
console.log(`Block: ${solPrice.blockId}`);
console.log(`Decimals: ${solPrice.decimals}`);
```

---

## Token Shield — Security Checks

Jupiter provides a security check endpoint to detect potentially dangerous tokens.

### GET /swap/v2/shield — Check Token Safety

```typescript
const response = await fetch(
  `https://api.jup.ag/swap/v2/shield?mints=${mintAddress}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const shield = await response.json();
// Returns warnings about: freeze authority, mint authority, low organic activity, etc.
```

The `mints` parameter accepts comma-separated mint addresses (up to 100).

### Helius Synergy

Combine Token Shield with Helius DAS for comprehensive token safety:

```typescript
// 1. Jupiter Token Shield — check for freeze/mint authority risks
const shieldData = await checkTokenShield(mintAddress);

// 2. Helius DAS — check token metadata, supply, and holder distribution
// Use getAsset MCP tool for metadata
// Use getTokenHolders MCP tool for holder concentration
// High holder concentration + freeze authority = high risk
```

**Best practice**: Always run Token Shield before displaying unknown tokens in a swap UI. Show warnings to users.

---

## Building a Token Selector

Combine Jupiter Tokens API with Helius DAS for a complete token selector:

```typescript
// 1. Get user's token holdings via Helius
// Use getAssetsByOwner MCP tool with showFungible: true

// 2. Enrich with Jupiter metadata
// For each holding, fetch token info from Jupiter Tokens API v2

// 3. Get live prices
// Batch mint addresses into Price API v3 calls (max 50 per request)

// 4. Display with verification status
// Show verified badge, price, and balance
```

See `references/integration-patterns.md` Pattern 2 for the complete implementation.

---

## Common Pitfalls

1. **Max 50 mints per price request** — Batch larger lists into multiple calls
2. **Max 100 mints per Token Shield / token lookup** — Use comma-separated values
3. **Verify tokens before displaying** — Check `isVerified` and `organicScore` to filter scam tokens
4. **Prices are in USD** — The field is `usdPrice`, not `price`
5. **Price API v3 has no `data` wrapper** — Access prices as `response[mint]`, NOT `response.data[mint]`. There is also no `id` field per entry. Using `response.data[mint]` will silently return `undefined`.
5. **Use Helius DAS for ownership data** — Jupiter Tokens API provides metadata, not wallet-specific data
6. **Tokens API is v2, Price API is v3** — Don't use the old v1/v2 endpoints

---

## Resources

- Tokens API Docs: [dev.jup.ag/docs/tokens](https://dev.jup.ag/docs/tokens)
- Price API Docs: [dev.jup.ag/docs/price](https://dev.jup.ag/docs/price)
