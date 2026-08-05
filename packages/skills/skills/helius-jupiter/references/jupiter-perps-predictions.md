# Jupiter Perpetuals & Prediction Markets

## What This Covers

Jupiter's leveraged trading (Perps) and event-based trading (Prediction Markets). Both are more advanced features with limited API availability.

---

## Perpetuals (On-Chain Only)

Jupiter Perps allows leveraged long/short trading on SOL, ETH, BTC, and other assets. There is **no REST API** currently — all interaction is via on-chain Anchor programs.

### Key Concepts

- **Position Account**: Tracks a user's leveraged position (side, size, collateral, entry price, PnL)
- **PositionRequest Account**: Pending open/close/modify orders
- **Pool Account**: JLP (Jupiter Liquidity Provider) pool configuration and AUM
- **Custody Account**: Per-token state (SOL, ETH, BTC, USDC, USDT)

### Program ID

```
PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu
```

### Reading Position Data

Since there's no REST API, read position data directly from on-chain accounts:

```typescript
// Use Helius getAccountInfo MCP tool to read position accounts
// Or use getProgramAccounts to find all positions for a wallet

// Position accounts are owned by the Jupiter Perps program
// Decode using the Anchor IDL from Jupiter
```

### Helius Synergies

- **getAccountInfo** — Read position account data on-chain
- **getProgramAccounts** — Find all positions for a specific wallet or market
- **WebSockets (accountSubscribe)** — Monitor position changes in real time (liquidation alerts, PnL updates)
- **LaserStream** — Shred-level monitoring for liquidation engines
- **parseTransactions** — Human-readable history of perps trades

### Building a Perps UI

1. Use Helius `getProgramAccounts` to fetch user's positions from the Perps program
2. Decode position data using Jupiter's Anchor IDL
3. Subscribe to position accounts via Helius WebSockets for real-time PnL
4. Submit position open/close transactions via Helius Sender
5. Use `getPriorityFeeEstimate` for optimal fee levels

---

## Prediction Markets (Beta)

Jupiter aggregates prediction markets from Polymarket and Kalshi, allowing users to trade on real-world events.

### Restrictions

- **Geo-restricted**: Blocked in the US and South Korea
- **Beta**: API may change

### Base URL & Auth

```
Base: https://api.jup.ag/prediction/v1
Auth: x-api-key header (required)
```

### Endpoints

#### GET /events — List Events

```typescript
const response = await fetch('https://api.jup.ag/prediction/v1/events', {
  headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
});

const events = await response.json();
// Returns: array of events with markets, categories, status
```

#### GET /markets/{marketId} — Market Details

```typescript
const response = await fetch(
  `https://api.jup.ag/prediction/v1/markets/${marketId}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const market = await response.json();
// Returns: market details, pricing, YES/NO token mints
```

#### GET /orderbook/{marketId} — Order Book

```typescript
const response = await fetch(
  `https://api.jup.ag/prediction/v1/orderbook/${marketId}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const orderbook = await response.json();
// Returns: bid/ask depth for the market
```

#### POST /orders — Place Order

```typescript
const response = await fetch('https://api.jup.ag/prediction/v1/orders', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    marketId,
    isYes: true, // true for YES, false for NO
    isBuy: true, // true for buy, false for sell
    depositAmount: '1000000', // USDC atomic units
    depositMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    ownerPubkey: walletPublicKey,
  }),
});

const order = await response.json();
// Returns: { transaction, ... }
```

#### GET /positions — User Positions

```typescript
const response = await fetch(
  `https://api.jup.ag/prediction/v1/positions?ownerPubkey=${walletPublicKey}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const positions = await response.json();
// Returns: holdings, P&L, claimable payouts
```

#### POST /positions/{positionPubkey}/claim — Claim Payout

After an event resolves, claim winnings:

```typescript
const response = await fetch(
  `https://api.jup.ag/prediction/v1/positions/${positionPubkey}/claim`,
  {
    method: 'POST',
    headers: {
      'x-api-key': process.env.JUPITER_API_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ownerPubkey: walletPublicKey,
    }),
  }
);

const claim = await response.json();
// Returns: { transaction, ... }
```

### Helius Synergies

- **Helius Sender** — Submit prediction market order transactions for optimal landing
- **parseTransactions** — Human-readable history of prediction market trades
- **WebSockets** — Monitor market account changes for live price updates
- **Wallet API** — Show user's prediction market token holdings alongside other assets

### Building a Prediction Market UI

1. Fetch events and markets from Jupiter Prediction API
2. Display orderbook data for selected markets
3. Check geo-restrictions before allowing trades
4. Submit order transactions via Helius Sender
5. Monitor positions via Helius WebSockets
6. Use `parseTransactions` for trade history

---

## Resources

- Jupiter Perps Docs: [dev.jup.ag/docs/perps](https://dev.jup.ag/docs/perps)
- Jupiter Prediction Markets: [dev.jup.ag/docs/prediction](https://dev.jup.ag/docs/prediction)
- Perps Program: `PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu`
