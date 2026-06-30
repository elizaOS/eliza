# #9899 — DB-backed pending-charge + settlement ledger (Tier 3)

The pre-forward TTFT root cause in #9899 was fixed and shipped (Tier 1 auth cache +
Tier 2 optimistic billing, live in prod). The only remaining **code** work the
issue + `docs/inference-hot-path.md` named was the **DB-backed pending-charge +
settlement ledger** that closes the three at-scale residuals a KV-only backstop
cannot. This change implements it, flag-gated `INFERENCE_BILLING_LEDGER="db"`
(default `""`/`kv` = no behavior change), matching the soak-then-cutover rollout
discipline the issue itself prescribed.

## What landed

| File | Change |
|---|---|
| `packages/cloud/shared/src/db/schemas/inference-pending-charges.ts` | New table schema (PK `request_id`, partial indexes) |
| `packages/cloud/shared/src/db/migrations/0153_inference_pending_charges.sql` + journal | Additive, idempotent migration |
| `packages/cloud/shared/src/lib/services/inference-billing-ledger.ts` | `admitInferenceChargeViaLedger`, `createLedgerDebitSettler`, `sweepStalePendingInferenceChargesDb`, `resolveInferenceBillingLedger` |
| `packages/cloud/api/v1/chat/completions/route.ts` · `v1/embeddings/route.ts` | DB-ledger admission branch (KV path byte-identical when flag unset) |
| `packages/cloud/api/cron/sweep-inference-charges/route.ts` | Dispatch to DB sweep when selected |
| `packages/cloud/api/wrangler.toml` · `types/cloud-worker-env.ts` | `INFERENCE_BILLING_LEDGER` flag (off in all envs) |
| `packages/cloud/api/docs/inference-hot-path.md` | Tier-3 section + cutover plan |

## Residuals closed (each point-for-point)

1. **Hard concurrent-overdraw bound** — admission is one atomic `FOR UPDATE` +
   `SUM(pending)` statement; a same-org burst serializes and cannot collectively
   overdraw (was: KV soft bound via threshold only).
2. **True exactly-once settlement** — `request_id` PK + atomic
   `UPDATE … WHERE status='pending'` claim; inline settler and cron sweep can
   never both charge (was: KV near-atomic get-then-delete → rare double-bill). No
   single-flight lock needed anymore.
3. **Age-ordered sweep drain** — `ORDER BY enqueued_at LIMIT batch` loop over a
   partial index, no silent `maxKeys` cap (was: unordered bounded prefix scan).

Plus `uncollected` becomes a first-class auditable row state; the org self-heals
onto the synchronous-reserve path on a refused debit.

## Test evidence — 90 pass / 0 fail (real DB, no larp)

Every test drives the **real SQL against in-process PGlite** (same pattern as the
audited `credits-deduct-guard.test.ts`); only fire-and-forget non-billing
side-effects (email/webhook/auto-top-up) are stubbed.

```
inference-billing-ledger.test.ts              15 pass   (admission/settle/sweep/concurrency)
inference-pending-charges-migration.test.ts    6 pass   (journal reg + real-DB apply + idempotent)
inference-billing-fast-path.test.ts           28 pass   (KV path — no regression)
inference-billing-cache-failure.test.ts        2 pass
inference-auth-context.test.ts                12 pass
inference-auth-lifecycle.test.ts               7 pass
inference-hot-path-benchmark.test.ts           3 pass
credits-deduct-guard.test.ts                   9 pass   (credit mutation — no regression)
credits-reconcile.test.ts                      8 pass
------------------------------------------------------------
TOTAL                                         90 pass / 0 fail
```

New-file typecheck: clean (only pre-existing i18n/hono-dup/stripe-version noise).
Biome: clean on all changed files. The route-level runtime tests
(`chat-completions-optimistic-billing.test.ts`) need a built `@elizaos/core`
dist, which cannot be generated in this worktree (`tsc` can't resolve
`@types/bun`/`@types/node` — the shared-parent-`node_modules` limitation); they
run in CI. The DB-ledger route branch is type-checked clean and the KV path is
structurally unchanged when `INFERENCE_BILLING_LEDGER` is unset.

## Measurement — the hard overdraw bound, quantified

`9899-db-ledger-overdraw-measurement.json` — concurrent bursts of optimistic
admissions against a fixed balance:

| Burst × estimate | Balance | Threshold | Admitted | Rejected | In-flight reserved | Naive (unbounded) | **Overdraw prevented** | Final balance ≥ 0 |
|---|---|---|---|---|---|---|---|---|
| 50 × $3 | $100 | $1 | 33 | 17 | $99 | $150 | **$50** | $1 ✓ |
| 20 × $10 | $100 | $5 | 10 | 10 | $100 | $200 | **$100** | $0 ✓ |
| 100 × $1 | $25 | $0.50 | 25 | 75 | $25 | $100 | **$75** | $0 ✓ |

In every scenario the total in-flight reserved is `≤` the balance and the
post-settle balance never goes negative — the guarantee the KV soft-bound cannot
provide (it would have admitted the full naive in-flight).
