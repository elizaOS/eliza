# Jupiter Swap API V2

## What This Covers

Token swaps via Jupiter's Swap API V2 — getting quotes, executing swaps, building custom transactions, handling idempotency, and production hardening. V2 provides optimized routing across all Solana DEXes through multi-router competition.

---

## Base URL & Auth

```
Base: https://api.jup.ag/swap/v2
Auth: x-api-key header (required)
```

Rate limits are dynamic — see `references/jupiter-portal.md` for details.

---

## Two Paths

Jupiter V2 offers two integration paths:

| Feature | `/order` + `/execute` | `/build` |
|---------|----------------------|----------|
| Routing | All routers (Metis, JupiterZ RFQ, DFlow, OKX) | Metis only |
| Swap fees | Jupiter platform fee included | None |
| Execution | Managed via `/execute` (Jupiter Beam) | Self-managed (your own RPC) |
| Transaction control | None (pre-built) | Full (raw instructions) |
| Compute budget | Included in transaction | Instructions provided (overridable) |
| Jito tip inclusion | Handled internally by Jupiter Beam (no tip ix in the returned transaction; landing is Jupiter's responsibility) | Not included — you add a `SystemProgram.transfer` to a Jito tip account when submitting via Helius Sender |

**Use `/order` + `/execute`** for most integrations (recommended). **Use `/build`** only when you need custom instructions, CPI, or full transaction control.

> **Using Helius Sender?** Sender's dual-routing (Jito) requires a tip transfer **inside** the transaction. `/order`'s pre-built transaction does not include one, so signing and forwarding it to Sender will fail to land via Jito. Use `/build` and assemble the transaction yourself — see `references/integration-patterns.md` Pattern 1 for the full recipe and `references/helius-sender.md` for tip accounts and minimum amounts.

---

## Path 1: Order & Execute (Recommended)

### GET /order — Get Quote + Transaction

Returns a swap quote with a pre-built transaction. Omit `taker` to get a quote-only response — `transaction` will be null but `requestId` and the rest of the quote data are still returned.

```typescript
const params = new URLSearchParams({
  inputMint: 'So11111111111111111111111111111111111111112', // SOL
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  amount: '1000000000', // 1 SOL in lamports
  taker: walletPublicKey, // Optional — omit for quote-only
});

const response = await fetch(`https://api.jup.ag/swap/v2/order?${params}`, {
  headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
});

const order = await response.json();
// Returns: { transaction, requestId, inputMint, outputMint, inAmount, outAmount, router, mode, feeBps, feeMint }
// If taker is omitted (quote-only): `transaction` is null, but `requestId` and the rest of the quote data are still returned
```

**Required parameters**:
- `inputMint` — Source token mint address
- `outputMint` — Destination token mint address
- `amount` — Amount in atomic units (lamports for SOL, raw units for SPL tokens)
- `taker` — Wallet public key that will sign (required for transaction, omit for quote-only)

**Optional parameters**:
- `slippageBps` — Slippage tolerance in basis points (default: auto via RTSE)
- `receiver` — Destination wallet for output tokens (defaults to `taker`)
- `referralAccount` — Referral account for integrator fees
- `referralFee` — Referral fee in basis points (50-255 bps)
- `excludeRouters` — Comma-separated routers to exclude: `iris`, `jupiterz`, `dflow`, `okx`
- `excludeDexes` — Comma-separated DEXes to exclude from routing

**Response fields**:
- `transaction` — Base64-encoded transaction (null when `taker` is omitted)
- `requestId` — Returned on every response (including quote-only); required for `/execute` and idempotent retries
- `outAmount` — Expected output before slippage
- `router` — Winning router (`iris`, `jupiterz`, `dflow`, `okx`)
- `mode` — `ultra` (default params, all routers) or `manual` (optional params detected, routing restricted)
- `feeBps` — Fee basis points applied
- `feeMint` — Token used for fee

### POST /execute — Execute Swap

Submit the signed transaction for managed execution.

```typescript
// 1. Deserialize and sign
const txBuffer = Buffer.from(order.transaction, 'base64');
const transaction = VersionedTransaction.deserialize(txBuffer);
transaction.sign([keypair]);

// 2. Execute via Jupiter
const signedTx = Buffer.from(transaction.serialize()).toString('base64');
const execRes = await fetch('https://api.jup.ag/swap/v2/execute', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    signedTransaction: signedTx,
    requestId: order.requestId,
  }),
});

const result = await execRes.json();
// Success: { status: "Success", signature, inputAmountResult, outputAmountResult, swapEvents }
// Failure: { status: "Failed", code, error }
```

**CRITICAL**: Always include `requestId` from the `/order` response. This enables idempotent retries — if the request fails mid-flight, re-call `POST /execute` with the same `requestId` and `signedTransaction` to check status.

**Jupiter execution features**:
- RTSE (Real-Time Slippage Estimator) — adjusts slippage at execution time
- Optimized priority fee strategy for current network conditions
- Jupiter Beam — proprietary transaction execution pipeline across multiple RPC providers
- Confirmation polling and transaction parsing

### Using Jupiter Quote + Helius Sender (Alternative)

For more control over transaction submission, you can use Jupiter for the quote/transaction and Helius Sender for submission. See `references/integration-patterns.md` Pattern 1.

---

## Path 2: Build Custom Transactions (Advanced)

### GET /build — Get Instructions

Returns raw swap instructions for custom transaction assembly.

```typescript
const params = new URLSearchParams({
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '1000000000',
  taker: walletPublicKey,
});

const response = await fetch(`https://api.jup.ag/swap/v2/build?${params}`, {
  headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
});

const buildResult = await response.json();
```

**Response fields**:
- `computeBudgetInstructions` — Compute unit price instruction (no limit — you must simulate)
- `setupInstructions` — Pre-swap setup (ATA creation, etc.)
- `swapInstruction` — Main swap instruction
- `cleanupInstruction` — Post-swap cleanup (nullable)
- `otherInstructions` — Additional instructions
- `addressesByLookupTableAddress` — V0 transaction lookup tables
- `blockhashWithMetadata` — Blockhash and expiry height

**Build flow**:
1. Call `/build` with required params
2. Add your custom instructions alongside swap instructions
3. Simulate with max CU limit (1,400,000) to estimate actual usage
4. Build V0 transaction with estimated CU limit (1.2x simulated, capped at 1,400,000)
5. If submitting via Helius Sender, append a `SystemProgram.transfer` to a random Jito tip account (see `references/integration-patterns.md` Pattern 1)
6. Sign and send via your own RPC (or Helius Sender)

**Optional parameters**:
- `slippageBps` — Slippage tolerance (default: 50 bps)
- `mode` — `"fast"` for reduced latency routing
- `maxAccounts` — Max accounts for swap route (1-64, default 64)
- `platformFeeBps` — Integrator platform fee in bps
- `feeAccount` — Token account for platform fees (required if `platformFeeBps` > 0)
- `wrapAndUnwrapSol` — Auto wrap/unwrap SOL (default: true)
- `dexes` / `excludeDexes` — Include/exclude specific DEXes
- `blockhashSlotsToExpiry` — Slots until blockhash expires (1-300, default 150)

**Note**: `/build` only supports ExactIn mode. You are responsible for sending the transaction via your own RPC and handling confirmation. Jupiter does not charge swap fees on `/build`.

---

## Routing

Four routers compete for best pricing on `/order`:

- **Metis** — Jupiter's on-chain aggregator (core routing engine)
- **JupiterZ** — RFQ market makers (off-chain liquidity, often beats on-chain by 5-20 bps on major pairs)
- **DFlow** — Third-party order flow
- **OKX** — Third-party liquidity provider

**Parameter impact on routing**:
- `receiver`, `referralAccount`, `referralFee` — disables JupiterZ only (Metis, DFlow, OKX still compete)
- `payer` — disables JupiterZ, DFlow, AND OKX (reduces to **Metis only**)

Check the `mode` field in the response (`ultra` = all routers, `manual` = restricted).

---

## Fees

### `/order` Platform Fees

| Token Pair | Fee |
|------------|-----|
| Jupiter tokens (SOL/Stable → JUP/JLP/jupSOL) | 0 bps |
| Pegged assets (LST-LST, Stable-Stable) | 0 bps |
| SOL-Stable | 2 bps |
| LST-Stable | 5 bps |
| Most other pairs | 10 bps |
| New tokens (within 24 hours) | 50 bps |

### Integrator Fees (Referral Program)

Use `referralAccount` and `referralFee` parameters on `/order`:
- `referralFee` range: 50-255 basis points
- Jupiter retains 20% of referral fees; you receive 80%
- **Adding `referralAccount` disables RFQ (JupiterZ) routing**

### `/build` Fees

No Jupiter platform fee. Implement custom fees via `platformFeeBps` and `feeAccount`.

---

## Gasless Swaps

### Automatic Gasless (`/order`)

Jupiter automatically covers all gas when the taker has insufficient SOL:
- Requires < 0.01 SOL in taker wallet
- Minimum trade: ~$10 USD equivalent
- Default `/order` parameters only (no integrator/manual mode params)
- Increases swap fee to compensate (reduces output tokens)

### JupiterZ Gasless

When RFQ market makers win the quote, they cover network and priority fees — but not ATA rent. Taker must have SOL for account creation.

### Integrator Payer

Pass `payer` parameter on `/order` or `/build` to subsidize all gas costs. Routes through Metis only.

---

## Slippage

- Default: auto-calculated by Jupiter's RTSE (Real-Time Slippage Estimator)
- Custom: pass `slippageBps` parameter (e.g., `50` = 0.5%)
- Recommended: use auto unless the user has a specific requirement
- Note: `slippageBps` is incompatible with automatic gasless swaps

---

## Common Mints

| Token | Mint Address |
|---|---|
| SOL | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

For other tokens, use the Jupiter Tokens API (`references/jupiter-tokens-price.md`) to look up mint addresses.

---

## Error Codes

### `/execute` Error Codes

| Code | Category | Meaning |
|------|----------|---------|
| 0 | Success | Transaction confirmed |
| -1 | Execute | Missing cached order (requestId not found or expired) |
| -2 | Execute | Invalid signed transaction |
| -3 | Execute | Invalid message bytes |
| -1000 | Aggregator | Failed to land |
| -1001 | Aggregator | Unknown error |
| -1002 | Aggregator | Invalid transaction |
| -1003 | Aggregator | Transaction not fully signed |
| -1004 | Aggregator | Invalid block height |
| -2000 | RFQ | Failed to land |
| -2001 | RFQ | Unknown error |
| -2002 | RFQ | Invalid payload |
| -2003 | RFQ | Quote expired |
| -2004 | RFQ | Swap rejected |

Negative codes = Jupiter-internal (routing, slippage, etc.) — typically transient, retry with fresh quote. Positive codes = on-chain program errors.

### Timeout Handling

- Set 5-second timeout for `/order` (quote) requests
- Set 30-second timeout for `/execute` requests
- If `/execute` times out, re-call with the same `requestId` and `signedTransaction` to check status — do NOT get a new quote without checking first

---

## Production Checklist

1. Always include `x-api-key` header
2. Always use `requestId` for idempotent retries
3. Set appropriate timeouts (5s quotes, 30s executions)
4. Implement exponential backoff for 429 responses
5. Validate mint addresses before calling the API
6. Enforce slippage guardrails for user protection
7. On timeout, re-call `/execute` with same requestId to check status
8. Check `mode` field to verify expected routing behavior
9. Log all API interactions with latency metrics

---

## Migration from Ultra / Metis

- **From Ultra**: Update base URL from `https://ultra-api.jup.ag` to `https://api.jup.ag/swap/v2`. Request params and response format are identical.
- **From Metis**: Consolidates `/quote` + `/swap-instructions` into single `/build` endpoint. `userPublicKey` becomes `taker`. Route plan uses `bps` instead of `percent` (10000 bps = 100%).

---

## Resources

- Swap API V2 Docs: [dev.jup.ag/docs/swap](https://dev.jup.ag/docs/swap)
- Jupiter Portal (API keys): [developers.jup.ag/portal](https://developers.jup.ag/portal)
