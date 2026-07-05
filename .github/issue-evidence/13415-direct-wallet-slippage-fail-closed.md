# #13415 slice — direct-wallet-payments.ts native-coin slippage band fail-closed

## Defect (fallback-slop / fail-OPEN money gate)

`directMetadata()` read the native-coin slippage tolerance as:

```ts
slippageBps: Number(metadata.slippage_bps ?? 0),
```

with **no validation**. That value flows into `verifyEvmNativePayment` where it
gates the accepted-payment band for native-coin (BNB/ETH) direct-wallet
deposits:

```ts
const slippageBps = BigInt(params.slippageBps ?? 0);
const floor   = slippageBps > 0n ? (expected * (10_000n - slippageBps)) / 10_000n : expected;
const ceiling = slippageBps > 0n ? (expected * (10_000n + slippageBps)) / 10_000n : expected;
```

Two silent failure modes the bare `Number()` read left open:

1. **Band-widening (fail-open, credits gross over/under-payment).** A large
   positive `slippage_bps` (DB corruption, a tampered metadata row, or a future
   non-canonical writer) widens the accepted band without bound. E.g.
   `slippage_bps = 990000` on a 1e6-unit quote yields a ceiling of **100x**
   expected — the exact "gross overpayment silently loses the user money"
   scenario the ceiling comment says it protects against, and a floor that
   collapses toward zero. The canonical write path only ever stores
   `NATIVE_SLIPPAGE_BPS` (200) or 0, so any larger value is untrustworthy.
2. **`BigInt(NaN)` / `BigInt(1.5)` throw deep in verify.** A non-numeric /
   fractional / Infinity `slippage_bps` makes `Number()` produce a value
   `BigInt()` rejects, crashing the confirm path with an opaque `RangeError`
   instead of an intelligible refusal.

Solana and EVM-token verify paths do NOT use slippage, so the surface is
precisely the EVM native path.

## Fix (fail-closed boundary)

- New colocated `parseDirectWalletSlippageBps(rawValue)` + distinct
  `CorruptDirectWalletSlippageError`. Accepts only a finite, non-negative
  **integer** in `[0, MAX_DIRECT_SLIPPAGE_BPS = 200]`, matching the canonical
  native-token tolerance; missing/null is the legitimate stable-token default of
  0. Everything else throws.
- `10_000` bps is refused. At 100% tolerance the native floor becomes zero, so
  a tampered metadata row could otherwise credit a zero-value native transfer.
- `directMetadata()` now uses the parser. The throw propagates inside the
  `dbWrite.transaction` in `confirmPayment` / `verifyAndConfirmBroadcast`,
  rolling the tx back and refusing to credit — fail-closed, no fabricated
  settlement.

## Tests

`__tests__/direct-wallet-slippage-fail-closed.test.ts` — 12/12 green under
`bun test`:
- parser boundary: undefined/null→0, 0/200 canonical, NUMERIC-string,
- FAIL-OPEN REGRESSION guards: oversized (1e6 / 10000 / 201), NaN / non-numeric
  string, Infinity, fractional, negative — all REFUSED;
- distinct error type/message;
- band math reproduced to prove an UNVALIDATED oversized slippage would have
  accepted a 100x overpayment (which the parser now refuses).
- Native integration slice includes a corrupted `slippage_bps = 10000` payment
  with an otherwise successful zero-value tx; confirm rejects before crediting.

Sibling direct-wallet suites (confirm-atomic, payer-proof, integration): 9 pass
/ 0 fail (39 RPC-gated integration cases skip, pre-existing) — no regression.

## Gates
- `bun test` slice 12/12 + siblings 9/9 green.
- tsgo: 0 errors in touched file (18 pre-existing baseline errors elsewhere:
  app-core symlink resolution, in-flight brand-env-aliases, node-redis,
  plugin-mcp, anthropic-web-search — identical on develop).
- biome: clean.
- error-policy-ratchet: no new fallback-slop.

`-- [sol-orch]`
