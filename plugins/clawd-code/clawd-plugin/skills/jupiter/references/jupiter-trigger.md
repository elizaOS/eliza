# Jupiter Trigger API V2 — Limit Orders

## What This Covers

Limit orders via Jupiter's Trigger API V2 — placing price-triggered orders (single, OCO, OTOCO), managing vault deposits, viewing order history, canceling orders, and updating order parameters. V2 uses JWT authentication, vault-based deposits, and USD price triggers.

---

## Base URL & Auth

```
Base: https://api.jup.ag/trigger/v2
Auth: x-api-key header (required) + JWT Bearer token (required for most endpoints)
Status: Beta, under active development
```

> **Trigger V2 is in active beta.** Endpoints, response shapes, and onboarding flows shift without notice. Verify against [dev.jup.ag/docs/trigger](https://dev.jup.ag/docs/trigger) before relying on this reference.

---

## Authentication (JWT Challenge-Response)

Before placing or managing orders, authenticate via a two-step challenge-response flow to obtain a JWT.

### Step 1: Request Challenge

```typescript
const challengeRes = await fetch('https://api.jup.ag/trigger/v2/auth/challenge', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    walletPubkey: walletPublicKey,
    type: 'message', // 'message' for software wallets, 'transaction' for hardware wallets
  }),
});

const challenge = await challengeRes.json();
// message type: { type: "message", challenge: "Sign this message to authenticate..." }
// transaction type: { type: "transaction", transaction: "<base64 tx with memo>" }
```

Challenge TTL: **5 minutes**. Request a new one if it expires.

### Step 2: Sign & Verify

```typescript
// Sign the challenge message with the wallet
const signature = await wallet.signMessage(new TextEncoder().encode(challenge.challenge));

const verifyRes = await fetch('https://api.jup.ag/trigger/v2/auth/verify', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    type: 'message',
    walletPubkey: walletPublicKey,
    signature: bs58.encode(signature), // base58-encoded signature
  }),
});

const { token } = await verifyRes.json();
// token: JWT valid for 24 hours
```

JWT TTL: **24 hours**. No refresh endpoint — re-authenticate when expired.

**Security**: A leaked JWT allows order cancellation and parameter edits, but **not** fund withdrawal — all fund operations require wallet-signed transactions.

---

## Vault Management

Each wallet gets **one vault** (Privy-managed custodial account). Deposits go from wallet into vault, which backs all orders.

```typescript
const headers = {
  'x-api-key': process.env.JUPITER_API_KEY!,
  'Authorization': `Bearer ${jwtToken}`,
};

// Check if a vault exists for this wallet
const vaultRes = await fetch('https://api.jup.ag/trigger/v2/vault', { headers });
// Returns: { userPubkey, vaultPubkey, privyVaultId, privyUserId? }
// Returns 404 if no vault exists (user has not completed onboarding)
```

### Vault Onboarding

Programmatic vault registration via the public API is **not currently available**. Jupiter's `POST /trigger/v2/vault/register` route returns a router-level plain-text `404 Not Found` in production, even with a valid JWT and `x-api-key`. Vault provisioning happens through Privy onboarding inside the **jup.ag web UI**.

If `GET /trigger/v2/vault` returns `404`, surface a clear message to the user instructing them to visit [jup.ag](https://jup.ag) and complete the Trigger onboarding flow once. Subsequent `GET /vault` calls (and `POST /deposit/craft`, `POST /orders/price`, etc.) will succeed against the provisioned vault. There is no need to repeat the web flow per session — vaults are permanent per wallet.

For headless agents that cannot route a user through the web UI, contact Jupiter support — there is no documented programmatic onboarding path at present.

> **Error shapes.** Trigger V2 app-level errors return JSON like `{"error":"..."}`. A plain-text `404 Not Found` response body means the route is not registered server-side — re-check [dev.jup.ag/docs/trigger](https://dev.jup.ag/docs/trigger) rather than assuming a parameter, header, or auth issue. This distinction saves a debugging round-trip on a beta API.

---

## How Trigger V2 Orders Work

Jupiter Trigger V2 creates off-chain limit orders that execute automatically when the target **USD price** is reached. Orders are stored off-chain (MEV-resistant) and executed by Jupiter's keeper network.

### Order Types

- **Single** — Triggers when USD price crosses above or below a threshold. Standard limit orders and stop-losses.
- **OCO (One-Cancels-Other)** — Two orders sharing one deposit: one take-profit, one stop-loss. When one fills, the other cancels automatically.
- **OTOCO (One-Triggers-One-Cancels-Other)** — A parent order triggers first, then activates a TP/SL pair (OCO) on the output tokens.

### Fees

- **Non-stable pairs**: 0.1% execution fee
- **Stable pairs** (e.g., USDC/USDT): 0.03% execution fee

Fees are deducted from the output amount at execution time.

### Minimums

- **Minimum order value**: $10 USD equivalent

---

## Order Creation (3-Step Process)

### Step 1: Craft Deposit Transaction

```typescript
const depositRes = await fetch('https://api.jup.ag/trigger/v2/deposit/craft', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    inputMint: 'So11111111111111111111111111111111111111112', // SOL
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    userAddress: walletPublicKey,
    amount: '1000000000', // 1 SOL in lamports
  }),
});

const deposit = await depositRes.json();
// Returns: { transaction, requestId, receiverAddress, mint, amount, tokenDecimals }
```

### Step 2: Sign the Deposit Transaction

```typescript
import { VersionedTransaction } from '@solana/web3.js';

const transaction = VersionedTransaction.deserialize(
  Buffer.from(deposit.transaction, 'base64')
);
transaction.sign([keypair]);
const depositSignedTx = Buffer.from(transaction.serialize()).toString('base64');
```

### Step 3: Create Order with Signed Deposit

```typescript
// Single limit order example: sell 1 SOL when price hits $200
const orderRes = await fetch('https://api.jup.ag/trigger/v2/orders/price', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    orderType: 'single',
    depositRequestId: deposit.requestId,
    depositSignedTx: depositSignedTx,
    userPubkey: walletPublicKey,
    inputMint: 'So11111111111111111111111111111111111111112',
    inputAmount: '1000000000',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    triggerMint: 'So11111111111111111111111111111111111111112', // Monitor SOL price
    triggerCondition: 'above', // Trigger when price goes above target
    triggerPriceUsd: 200, // $200 USD
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days (milliseconds)
    // Optional:
    // slippageBps: 50,
  }),
});

const order = await orderRes.json();
// Returns: { id, txSignature }
```

### Common Required Fields (All Order Types)

| Field | Type | Description |
|---|---|---|
| `orderType` | `"single"` / `"oco"` / `"otoco"` | Order type |
| `depositRequestId` | string | From `/deposit/craft` response |
| `depositSignedTx` | string | Base64-encoded signed deposit transaction |
| `userPubkey` | string | Wallet public key |
| `inputMint` | string | Token being sold |
| `inputAmount` | string | Amount in atomic units |
| `outputMint` | string | Token being bought |
| `triggerMint` | string | Token whose USD price to monitor |
| `expiresAt` | number | Expiration timestamp in **milliseconds** |

### Single Order Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `triggerCondition` | `"above"` / `"below"` | Yes | Price direction trigger |
| `triggerPriceUsd` | number | Yes | USD price threshold |
| `slippageBps` | number | No | 0-10000 basis points |

### OCO Order Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `tpPriceUsd` | number | Yes | Take-profit USD price |
| `slPriceUsd` | number | Yes | Stop-loss USD price |
| `tpSlippageBps` | number | No | Take-profit slippage in bps |
| `slSlippageBps` | number | No | Stop-loss slippage in bps |

Constraint: `tpPriceUsd` must be greater than `slPriceUsd`.

### OTOCO Order Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `triggerCondition` | `"above"` / `"below"` | Yes | Parent trigger direction |
| `triggerPriceUsd` | number | Yes | Parent trigger USD price |
| `tpPriceUsd` | number | Yes | Secondary take-profit price |
| `slPriceUsd` | number | Yes | Secondary stop-loss price |
| `slippageBps` | number | No | Parent slippage |
| `tpSlippageBps` | number | No | Secondary TP slippage |
| `slSlippageBps` | number | No | Secondary SL slippage |

---

## OCO Example (Take-Profit + Stop-Loss)

```typescript
const ocoOrder = await fetch('https://api.jup.ag/trigger/v2/orders/price', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    orderType: 'oco',
    depositRequestId: deposit.requestId,
    depositSignedTx: depositSignedTx,
    userPubkey: walletPublicKey,
    inputMint: 'So11111111111111111111111111111111111111112',
    inputAmount: '1000000000',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    triggerMint: 'So11111111111111111111111111111111111111112',
    tpPriceUsd: 200, // Take profit at $200
    slPriceUsd: 120, // Stop loss at $120
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  }),
});
```

---

## Order Update

Update trigger prices and slippage on existing orders without canceling:

```typescript
const updateRes = await fetch(`https://api.jup.ag/trigger/v2/orders/price/${orderId}`, {
  method: 'PATCH',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    orderType: 'single',
    triggerPriceUsd: 210, // Updated price
    slippageBps: 100,
  }),
});
// Returns: { id }
```

Editable fields: trigger prices and slippage only. Amount/mint changes require canceling and recreating the order.

---

## Order Cancellation (2-Step Process)

### Step 1: Initiate Cancellation

```typescript
const cancelRes = await fetch(`https://api.jup.ag/trigger/v2/orders/price/cancel/${orderId}`, {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
  },
});

const cancel = await cancelRes.json();
// Returns: { id, transaction, requestId }
// Order transitions to "ready_to_cancel" — will NOT be filled even before step 2
```

### Step 2: Sign & Confirm

```typescript
// Sign the withdrawal transaction
const cancelTx = VersionedTransaction.deserialize(
  Buffer.from(cancel.transaction, 'base64')
);
cancelTx.sign([keypair]);

const confirmRes = await fetch(
  `https://api.jup.ag/trigger/v2/orders/price/confirm-cancel/${orderId}`,
  {
    method: 'POST',
    headers: {
      'x-api-key': process.env.JUPITER_API_KEY!,
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      signedTransaction: Buffer.from(cancelTx.serialize()).toString('base64'),
      cancelRequestId: cancel.requestId,
    }),
  },
);
// Returns: { id, txSignature }
```

If step 2 fails, retry with the **same** `cancelRequestId`. Expired orders use this same 2-step flow to recover vault funds.

---

## Order History

```typescript
const historyRes = await fetch(
  'https://api.jup.ag/trigger/v2/orders/history?state=active&limit=20&offset=0&sort=updated_at&dir=desc',
  {
    headers: {
      'x-api-key': process.env.JUPITER_API_KEY!,
      'Authorization': `Bearer ${jwtToken}`,
    },
  },
);

const history = await historyRes.json();
// Returns: { orders: OrderHistoryItem[], pagination: { total, limit, offset } }
```

**Query parameters**:
- `state` — `active` or `past`
- `mint` — Filter by token mint address
- `limit` — 1-100 (default: 20)
- `offset` — Pagination offset (default: 0)
- `sort` — `updated_at`, `created_at`, or `expires_at` (default: `updated_at`)
- `dir` — `asc` or `desc` (default: `desc`)

**Order states**: `pending`, `open`, `executing`, `filled`, `pending_withdraw`, `cancelled`, `expired`, `failed`

---

## Slippage Defaults

| Order Type | Default | Recommendation |
|---|---|---|
| Take-profit / buy-below | Auto via RTSE | Keep default |
| Stop-loss / buy-above | 20% (2000 bps) | Keep high for execution reliability |
| OTOCO parent | Auto via RTSE | Keep default |

Stop-loss orders use a higher default because execution certainty matters more than price precision when cutting losses.

---

## Common Pitfalls

1. **Minimum $10 order value** — Orders below this are rejected
2. **USD price triggers** — V2 uses `triggerPriceUsd` (USD price), not token ratios or raw amounts
3. **Expiration is required** — No indefinite (GTC) orders in V2. Use 7-30 days; renew via `PATCH` for longer duration
4. **`expiresAt` is in milliseconds** — Not seconds. Use `Date.now() + duration_ms`
5. **JWT expires after 24 hours** — Re-authenticate via challenge-response; no refresh endpoint
6. **Vault must be onboarded first** — `/vault/register` is not callable programmatically (returns plain-text `404`). If `GET /vault` returns `404`, route the user through jup.ag web onboarding once. See the "Vault Onboarding" section above.
7. **3-step order creation** — Craft deposit → sign → create order. All three steps are required
8. **2-step cancellation** — Initiate → sign withdrawal. Order won't fill after step 1 even if step 2 is delayed
9. **Amounts are in atomic units** — 1 SOL = 1_000_000_000 lamports, 1 USDC = 1_000_000
10. **Orders are stored off-chain** — Private by default, reducing MEV attack vectors
11. **Token-2022 (transfer tax tokens) not supported**
12. **Open orders continue executing after JWT expiration** — JWT is for management, not execution

---

## Resources

- Trigger API V2 Docs: [dev.jup.ag/docs/trigger](https://dev.jup.ag/docs/trigger)
