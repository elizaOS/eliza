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

1. **Hard concurrent-overdraw bound** — admission runs in a transaction behind a
   per-org `pg_advisory_xact_lock`, then reads the in-flight `SUM` of `pending`
   rows; the lock serializes admissions so each reads the SUM only after the prior
   commits → a same-org burst cannot collectively overdraw (was: KV soft bound).
2. **True exactly-once, crash-safe settlement** — `request_id` PK + an atomic
   `UPDATE … WHERE status='pending'` claim that runs in the SAME transaction as the
   debit; a crash between them rolls back (row stays `pending`, sweep recovers) and
   no over-admit window is ever visible (was: KV near-atomic get-then-delete → rare
   double-bill; a first cut also had a claim→debit crash window). No single-flight
   lock needed.
3. **Age-ordered sweep drain + bounded growth** — `ORDER BY enqueued_at LIMIT
   batch` loop over a partial index with an in-SQL (timezone-safe) cutoff, no
   silent cap; GCs terminal rows past retention (was: unordered bounded prefix
   scan). The cron sweeps both backends so a flag flip can't orphan rows.

Plus `uncollected` becomes a first-class auditable row state; the org self-heals
onto the synchronous-reserve path on a refused debit.

## Adversarial hardening (5-lens review, 3-vote verify)

After the first cut, a multi-agent adversarial review (5 money-safety lenses; each
finding confirmed/refuted by 3 independent skeptics) was run over the ledger — the
same discipline the Tier 1/2 design received. It confirmed 11 of 18 findings; the
material ones were **fixed**, and the design above is the corrected version:

| # | Confirmed defect | Fix |
|---|---|---|
| 3 / 10 (HIGH) | Admission `SUM` reads a stale MVCC snapshot under READ COMMITTED — `FOR UPDATE` on the org row does NOT serialize a cross-table SUM, so a same-org burst over-admits on real Postgres (the headline "hard bound" was false; PGlite's single connection hid it) | Admission now runs in a transaction behind a per-org `pg_advisory_xact_lock`, so the in-flight `SUM` is read only after concurrent admissions commit |
| 1 (HIGH) | claim and debit were separate auto-commit statements; a crash between them stranded the row `settled` with no debit, unrecoverable by the sweep (lost charge) | claim + debit now run in **one transaction** — a crash rolls back the claim, the row stays `pending`, the sweep recovers it |
| 6 (MED) | settle-window: between claim and debit a charge was out of `pending_sum` and not yet in balance → transient over-admit | closed by the same single-transaction settle (no intermediate state is ever visible) |
| 7 / 11 (HIGH/LOW) | sweep cutoff built as a client-side UTC `toISOString()` string vs a `timestamp`-without-tz column → skew under non-UTC session tz | cutoff computed **in SQL** (`enqueued_at < NOW() − interval`) — timezone-consistent |
| 9 (MED) | a flag flip between admit-time and sweep-time orphaned rows on the inactive backend | cron now sweeps **both** backends every run (idempotent) |
| 2 (LOW) | rows never GC'd → unbounded growth + a reused `request_id` pins an immortal row | sweep GCs terminal rows past a 24h retention window |
| 4 / 8 (MED/LOW) | tests asserted a bound PGlite can't prove; lost-charge path untested | concurrency test now documents the PGlite limitation; added dropped-inline-recovery + GC tests |

Confirmed parity residual **not** changed (it is a product-semantics call, shared
with the KV backstop): `billUsage` throwing after billable output → `settle(0)`
under-bills one request. Documented as a tracked follow-up, not a regression.
7 findings were adversarially **refuted** (e.g. sub-µ$ rounding, a markUncollected
race) and correctly dropped. Full reasoning archived in the workflow transcript.

## Test evidence — 97 pass / 0 fail (real DB, no larp)

Every test drives the **real SQL against in-process PGlite** (same pattern as the
audited `credits-deduct-guard.test.ts`); only fire-and-forget non-billing
side-effects (email/webhook/auto-top-up) are stubbed.

```
inference-billing-ledger.test.ts              18 pass   (admission/settle/sweep/concurrency/recovery/GC)
inference-pending-charges-migration.test.ts    6 pass   (journal reg + real-DB apply + idempotent)
cron/sweep-inference-charges/route.test.ts     4 pass   (sweeps both backends)
inference-billing-fast-path.test.ts           28 pass   (KV path — no regression)
inference-billing-cache-failure.test.ts        2 pass
inference-auth-context.test.ts                12 pass
inference-auth-lifecycle.test.ts               7 pass
inference-hot-path-benchmark.test.ts           3 pass
credits-deduct-guard.test.ts                   9 pass   (credit mutation — no regression)
credits-reconcile.test.ts                      8 pass
------------------------------------------------------------
TOTAL                                         97 pass / 0 fail
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
