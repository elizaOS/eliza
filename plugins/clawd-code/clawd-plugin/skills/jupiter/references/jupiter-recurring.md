# Jupiter Recurring API — Dollar-Cost Averaging (DCA)

## What This Covers

Recurring token purchases via Jupiter's Recurring API — setting up DCA orders, viewing active orders, and canceling orders.

---

## Base URL & Auth

```
Base: https://api.jup.ag/recurring/v1
Auth: x-api-key header (required)
```

---

## How DCA Works

Jupiter Recurring creates on-chain DCA orders that automatically execute at regular intervals. Jupiter's keeper network handles the periodic execution.

### Fees

- **0.1% execution fee** per individual order execution
- Fees are deducted from the output amount at each execution

### Minimums

- **Minimum total order value**: $100 USD equivalent
- **Minimum per-order value**: $50 USD equivalent
- **Minimum number of orders**: 2
- Orders that violate any of these minimums will be rejected

### Limitations

- **Token-2022 not supported** — Only standard SPL tokens are compatible with the Recurring API. Token-2022 mints will be rejected.
- **Price-based orders are deprecated** — The `params.price` field and `/priceDeposit` / `/priceWithdraw` endpoints are deprecated and no longer actively supported. Use time-based orders only.

---

## Endpoints

### POST /createOrder — Create DCA Order

```typescript
const response = await fetch('https://api.jup.ag/recurring/v1/createOrder', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    user: walletPublicKey,
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    outputMint: 'So11111111111111111111111111111111111111112', // SOL
    params: {
      time: {
        inAmount: '50000000', // 50 USDC per execution (atomic units)
        numberOfOrders: 10, // 10 executions total
        interval: 604800, // Interval in seconds: 86400=daily, 604800=weekly
        // Optional:
        // startAt: 1700000000, // Unix timestamp for first execution
        // minPrice: '100', // Min acceptable price
        // maxPrice: '200', // Max acceptable price
      },
    },
  }),
});

const result = await response.json();
// Returns: { requestId, transaction }
```

**Parameters**:
- `user` — Wallet public key
- `inputMint` — Token you're spending (e.g., USDC)
- `outputMint` — Token you're buying (e.g., SOL)
- `params.time.inAmount` — Amount per execution in atomic units
- `params.time.numberOfOrders` — Number of individual executions
- `params.time.interval` — Interval between executions in **seconds** (86400 = daily, 604800 = weekly, 2592000 = ~monthly)
- `params.time.startAt` — (Optional) Unix timestamp for first execution
- `params.time.minPrice` — (Optional) Minimum price threshold — skip execution if price is below
- `params.time.maxPrice` — (Optional) Maximum price threshold — skip execution if price is above

### Calculating Total Spend

```typescript
const perExecution = 50_000_000; // 50 USDC
const numberOfOrders = 10;
const totalSpend = perExecution * numberOfOrders; // 500 USDC total
// Total must be >= $100 USD equivalent
```

### GET /getRecurringOrders — List Active DCA Orders

```typescript
const response = await fetch(
  `https://api.jup.ag/recurring/v1/getRecurringOrders?user=${walletPublicKey}&orderStatus=active&recurringType=time`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

const orders = await response.json();
// Returns array of active DCA orders with progress, next execution time, etc.
```

**Parameters**:
- `user` — Wallet public key
- `orderStatus` — Required: `active` or `history`
- `recurringType` — Required: `time`

### POST /cancelOrder — Cancel DCA Order

```typescript
const response = await fetch('https://api.jup.ag/recurring/v1/cancelOrder', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    user: walletPublicKey,
    order: orderAddressToCancel,
    recurringType: 'time',
  }),
});

const cancelResult = await response.json();
// Returns: { requestId, transaction }
```

Canceling a DCA order returns any unspent input tokens to the user's wallet.

### POST /execute — Submit Signed Transaction

After signing a transaction from `/createOrder` or `/cancelOrder`, submit it back to Jupiter:

```typescript
const executeResponse = await fetch('https://api.jup.ag/recurring/v1/execute', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    signedTransaction: base64SignedTx,
    requestId: result.requestId,
  }),
});
```

---

## Transaction Flow

All Recurring API responses that modify state return `transaction` and `requestId`. Sign the transaction and submit via `/execute` or Helius Sender. See `references/jupiter-trigger.md` for the full signing/submission pattern.

---

## Common Pitfalls

1. **Minimum $100 total** — Total spend (`inAmount * numberOfOrders`) must be >= $100 USD equivalent
2. **Minimum $50 per order** — Each individual `inAmount` must be >= $50 USD equivalent
3. **Minimum 2 orders** — `numberOfOrders` must be >= 2
4. **Token-2022 not supported** — Only standard SPL tokens work; Token-2022 mints are rejected
5. **Amounts are in atomic units** — 500 USDC = 500_000_000
6. **Interval is in seconds** — Not a string like `'weekly'`. Use 86400 for daily, 604800 for weekly.
7. **Unspent funds returned on cancel** — Remaining input tokens go back to the wallet
8. **Each execution is a separate swap** — Price varies per execution (that's the point of DCA)
9. **Frequency determines the schedule** — The keeper network handles timing; you don't need to trigger executions manually
10. **Use `user` not `maker`** — The field is `user` for all Recurring endpoints
11. **Price-based orders are deprecated** — Use time-based orders (`params.time`) only

---

## Resources

- Recurring API Docs: [dev.jup.ag/docs/recurring](https://dev.jup.ag/docs/recurring)
