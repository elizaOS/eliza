# #13415 slice — payout-status.ts on-chain-balance NaN fail-open

`packages/cloud/shared/src/lib/services/payout-status.ts`
(fallback-slop successor to #12788; distinct file from prior #13415 slices:
auto-top-up #13507, agent-billing-gate #13522, token-redemption-secure #13518,
payout-processor #13508, oxapay #13527, plus live agent-budgets / x402 /
redeemable-earnings / credits sibling lanes.)

## Fallback census (before → after)

| path:line | pattern | verdict | fix |
| --- | --- | --- | --- |
| `payout-status.ts` EVM `checkEvmNetwork` | `balance = Number(rawBalance) / 10 ** decimals` with no finite guard, then `balance === 0` / `balance < LOW_BALANCE_THRESHOLD` classification | **FAIL-OPEN** money-availability gate | routed through fail-closed `classifyPayoutNetworkBalance` |
| `payout-status.ts` Solana `checkSolanaNetwork` | `balance = Number(account.amount) / 10 ** ELIZA_DECIMALS.solana` with no finite guard, same classification | **FAIL-OPEN** money-availability gate | routed through fail-closed `classifyPayoutNetworkBalance` |

## The bug (fail-OPEN)

Both per-network checks computed the token balance as
`Number(rawAmount) / 10 ** decimals` and then classified it with
`balance === 0` and `balance < LOW_BALANCE_THRESHOLD`. A corrupt / unparseable
on-chain read that **did not throw** (so `resolveNetworkStatus`'s outer
try/catch never caught it — `Number()` does not throw, it returns `NaN`) yields
`balance = NaN`:

- `NaN === 0` → `false`
- `NaN < LOW_BALANCE_THRESHOLD` → `false`

…so control fell through to the terminal
`status: "operational", hasBalance: true, message: "Operational with NaN tokens
available"`. That made `operationalNetworks.length > 0`, reported the whole
payout system `operational: true`, and **enabled token redemption against a
payout wallet whose balance was never verified** — a fail-open money gate (the
`PAYOUT_STATUS_ASSUME_OPERATIONAL` production guard elsewhere in the file
confirms "operational" is a real availability gate, not cosmetic).

## The fix (fail-CLOSED)

New pure, exported `classifyPayoutNetworkBalance(rawAmount, decimals)` computes
`balance` and returns the balance-derived `{ balance, hasBalance, status,
message }` subset. Fail-closed boundary: **`!Number.isFinite(balance) ||
balance < 0` →
`status: "not_configured"`, `hasBalance: false`, `balance: 0`** with an
explicit "Unable to verify payout wallet balance (unreadable on-chain value)"
message and an observable `logger.warn` at the call site — never `operational`.
For finite values the classification (`no_balance` / `low_balance` /
`operational`, exact messages + `>= threshold` boundary) is **behavior-preserving**.
Both `checkEvmNetwork` and `checkSolanaNetwork` now spread the classifier
result. `error`-flag (RPC read rejected) and setup-throw paths keep their
existing fail-closed `not_configured` returns.

## Tests

`payout-status-balance.test.ts` — 9/9 green (`bun test`, 31 expect calls):

- **fail-closed:** NaN raw balance → `not_configured` (regression: asserts the
  old fabricated `operational`/`low_balance` verdict + `NaN` message are gone),
  `Infinity` → `not_configured`, unparseable string → `not_configured`,
  impossible negative amount → `not_configured`.
- **preserved:** `0n` → `no_balance`; 50 tokens → `low_balance`; exactly 100
  (threshold) → `operational` (>= boundary); 12,345 tokens → `operational` with
  token count; a `bigint` on-chain amount (viem/spl-token read shape) classifies
  without throwing.

Existing `__tests__/payout-status-resilience.test.ts` 4/4 green (no regression to
the per-network degrade-on-throw contract).

## Verification

- `bun test src/lib/services/payout-status-balance.test.ts` → 9 pass / 0 fail.
- `bun test src/lib/services/__tests__/payout-status-resilience.test.ts` → 4 pass / 0 fail.
- `bunx @biomejs/biome check <touched files>` → clean, no fixes applied.
- `bun run audit:error-policy-ratchet` → "no new fallback-slop in touched files".
- `bun run --cwd packages/cloud/shared typecheck` → 13 pre-existing baseline
  errors, ALL in unrelated `packages/app-core/src/services/{account-pool,
  coding-account-bridge}.ts` (`@elizaos/auth` symlink-resolution drift documented
  in prior merged cloud-shared slices); **ZERO errors in the two touched files**.
- N/A rows: UI screenshots, model trajectories, audio — this is a service unit
  boundary that performs on-chain RPC reads only; no touched UI/model/audio
  surface.
