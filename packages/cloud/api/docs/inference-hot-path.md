# Inference hot path — single-entry auth cache + off-path billing

Refs: #9899 (root-cause), #9900 (instrumentation), #8434 (tracking).

> This design was hardened by an adversarial review (9-agent workflow, 4 lenses:
> billing-correctness, security-isolation, consistency-staleness,
> rollout-blast-radius). The review **rejected** the original "skip the upfront
> credit reserve entirely" model as billing-unsafe. The result is a two-tier
> plan: **Tier 1** (ship now — safe, default-on, fully testable) and **Tier 2**
> (deferred — requires a durable backstop before it can be correct). The
> blocker analysis that forced the split is in the appendix.

## Problem

A dedicated cloud-agent chat turn takes ~6–9s while cerebras-direct answers the
same prompt (`gpt-oss-120b`) in ~0.24s. #9899 measured that **100% of the
overhead is `cloud-api` pre-forward time-to-first-token** — work the Worker does
in `v1/chat/completions/route.ts` *before* forwarding to the model.

## Where the time goes (measured + code-traced)

Production config: `CACHE_BACKEND=auto` + `CACHE_KV` bound → Cloudflare KV is the
cache backend; `REDIS_RATE_LIMITING=false`. Pre-forward steps, serial:

| # | Step | Backend | Cost |
|---|------|---------|------|
| 1 | `requireAuthOrApiKeyWithOrg` → `validateApiKey` | KV read (hit) / Postgres (miss) | 1 RT |
| 2 | …→ `getWithOrganization` | KV read (hit) / Postgres (miss) | 1 RT |
| 3 | `enforceOrgRateLimit` | **no-op in prod** (`REDIS_RATE_LIMITING=false`) | 0 |
| 4 | Hono `rateLimit(RELAXED)` | **falls open in prod** (same flag) | 0 |
| 5 | `appsService.getById` | KV read — **only when `X-App-Id` present** | 0 for dedicated agents |
| 6 | `getCachedGatewayModelById` | KV SWR read (reasoning detection) | 1 RT |
| 7 | `contentModerationService.shouldBlockUser` | **Postgres read, UNCACHED** | 1 cross-region RT every request |
| 8 | `reserveCredits` | **Postgres write (transaction)** | 1 cross-region RT every request |

Findings: rate-limit is already a no-op in prod (not the hotspot). `shouldBlockUser`
is an **unconditional uncached Postgres read** on every request. `reserveCredits`
is a Postgres write. Post-response billing (`billUsage → reconcile → analytics →
audit`) is deferred via `executionCtx.waitUntil` (`settleOffResponsePath`) on
**both** response paths: the non-streaming handler defers the whole chain, and
the streaming handler's `onFinish` hands its (first-call-wins, single-flight)
settlement to the same seam — the AI SDK awaits `onFinish` before ending
`fullStream`, so an inline-awaited chain would hold the final SSE frame +
`[DONE]` hostage for the full write latency. Only the **upfront** reserve is
synchronous.

## Goal

Collapse the pre-forward auth/account-validity work to **a single cache read**,
remove the uncached moderation Postgres read from the hot path, and remove a KV
read for cerebras-native ids — without any billing-correctness regression.

---

## Tier 1 — single-entry auth+moderation cache (SHIP NOW, default-on)

### `InferenceAuthContext` (IAC) — one KV entry, API-key auth only

Collapse steps 1, 2, and 7 (auth + user/org + moderation) into one KV read.
Scope: **`X-API-Key` / `Bearer eliza_*` credentials only** — the actual
dedicated-agent hot path. Session-cookie, Bearer-JWT, and wallet auth always
take the existing authoritative slow path (they cannot be safely cached — see
appendix blockers SEC-1, SEC-2, RB-4).

```ts
interface InferenceAuthContext {
  v: 1;                 // schema discriminant; bump key suffix on breaking change
  cachedAt: number;
  userId: string;
  orgId: string;
  apiKeyId: string;
  keyHash: string;      // full sha256(key) — used for exact invalidation
}
```

Critically, **a positive IAC entry is only ever written when the credential is
FULLY authorized**: active user **and** active org **and** not suspended **and**
org present. There are **no** `userActive`/`orgActive`/`suspended` booleans in the
cached shape — their presence would tempt the route to render the rich
401/403/402 taxonomy from stale booleans (blocker RB-3). Any non-OK condition ⇒
**no positive cache** ⇒ the request falls to the authoritative chain, which
produces the exact `(status, code, message)` unchanged.

- **Key:** `iac:auth:<sha256(key)>:v1` (full sha256, env-prefixed by
  `CacheClient.pk()`). Full hash, not a 16-char prefix, so invalidation is exact.
- **TTL:** 60s. With KV propagation lag the real worst-case exposure of a
  revoked/banned credential is ~TTL + KV lag (~up to 2 min); TTL is the
  load-bearing bound (appendix CS-3). The `validateApiKey` 10-min positive cache
  is *also* cleared on revoke (it already is), so the slow path can't re-import a
  revoked key (blocker SEC-3).
- **Resolver `resolveInferenceAuthContext(req)`:**
  1. If not an API-key credential (wallet headers present, or Bearer-JWT, or
     cookie-only) → return `{ fastPath: false }`; route uses the slow path.
  2. `cache.get(iacKey)`. Shape-valid positive → return `{ fastPath: true, ctx }`.
  3. Miss → run authoritative chain ONCE: `requireAuthOrApiKeyWithOrg(req)` +
     `shouldBlockUser`. If authorized & not suspended → write IAC, return
     `{ fastPath: true, ctx }`. If suspended → return `{ fastPath: false,
     suspended: true }` (route 403s) and DO NOT write a positive entry.
  4. **No try/catch that returns a context on error.** Any error propagates
     (deny / 5xx). Never fail-open (blocker SEC-5).
- The route, on `fastPath: true`, uses `ctx.{userId, orgId, apiKeyId}` and
  **skips** `requireAuthOrApiKeyWithOrg` and `shouldBlockUser`, then continues
  the existing flow: rate-limit (429) → reserve (402) → forward. Order preserved
  (RB-6). The synchronous `reserveCredits` write **stays** — it is the correct,
  safe credit guard (a single indexed `FOR UPDATE` UPDATE).

### Catalog lookup for reasoning detection

`getCachedGatewayModelById` exists only for reasoning-parameter detection, and
`modelUsesReasoningTokens` already returns true via id name-pattern for the
cerebras ids (`gpt-oss-120b` → `/^gpt-oss/`, `zai-glm-4.7` → `/^zai-glm-/`). For
ids in the **`REASONING_MODEL_PATTERNS` allowlist**, skip the catalog read. This
must stay **pinned** to the name-pattern set with a guard test so a future
cerebras id that advertises reasoning only in the catalog can't silently lose
its reasoning-token floor (blocker RB-2).

### Invalidation wiring (Tier 1)

- API-key revoke/update/delete/deactivate (`api-keys.ts` lines 216/230/240/279):
  add `cache.del(iac:auth:<full key_hash>:v1)` alongside the existing
  `invalidateCache(key_hash)` (blocker SEC-3).
- `adminService.banUser()` + the moderation `onViolation` callback (≥5
  violations): fan out IAC deletes for all of the user's API keys via a new
  `apiKeysRepository.listByUser(userId)` (blockers SEC-1, SEC-6). Wire directly
  into `banUser`, not only the caller-provided callback (which does not auto-ban).
- User/org deactivation: same fan-out (CS-7).
- These are the only correctness-load-bearing invalidations; everything else is
  bounded by the 60s TTL.

### Rollout (Tier 1)

The IAC resolver is the only auth path for chat completions. API-key requests use
the auth-context cache when the shared cache backend is available; non-API-key
and cache-unavailable requests take the existing authoritative
`requireAuthOrApiKeyWithOrg` + `shouldBlockUser` path. Confirm via the
`[preforward]` log that eligible API-key auth+reads collapse to one cache read.

### Tests (Tier 1)

- **IAC resolver unit tests:** API-key hit; miss→populate; non-API-key→no
  fastPath; suspended→no positive entry + slow path; shape-guard reject; error
  propagates (never fail-open); cache-unavailable→slow path.
- **Invalidation unit tests:** revoke/ban deletes the IAC entry; ban fan-out
  across multiple keys; `listByUser` correctness.
- **Route regression:** 429→403→402 priority preserved; wallet headers disable
  fast path; app-credits path unchanged; catalog skip output-identical for the
  allowlisted ids; a non-pattern cerebras id is NOT skipped (guard test).
- **Benchmark/assertion:** warm IAC ⇒ hot path performs exactly **1
  cache read and 0 auth/moderation DB reads** before reserve (spy on cache + db).

---

## Tier 2 — optimistic off-path billing (IMPLEMENTED — flag-gated, default OFF)

The user's "fire off billing without blocking, no DB writes in the hot path" ask
means removing the synchronous `reserveCredits`. A naive "skip reserve + debit in
`waitUntil`" change is **not safe**; the review (appendix) showed it needs a
durable backstop and several guards. Tier 2 ships all of them behind
`INFERENCE_OPTIMISTIC_BILLING` (default OFF). Implementation lives in
`@/lib/services/inference-billing-fast-path` (settler, gate, sweep) and
`@/lib/services/inference-auth-cache` (org-balance hint). When eligible, the
org-credits branch SKIPS `reserveCredits` and instead: writes a durable KV
pending-charge → forwards → debits the ACTUAL cost off the response path (the
existing `settleReservation` chain, now backed by `createOptimisticDebitSettler`).

1. **Durable pending-charge backstop** independent of `waitUntil`
   (`writePendingInferenceCharge` → `iac:pending:<requestId>:v1`, TTL 1800s),
   written BEFORE forwarding. A `* * * * *` cron
   (`/api/cron/sweep-inference-charges` → `sweepStalePendingInferenceCharges`)
   settles entries older than a 20-min grace whose inline settle never ran,
   charging the ESTIMATE. Steady-state the inline settler deletes its own entry,
   so the sweep set is just rare stragglers — it does NOT process every request.
   Bounds dropped-`waitUntil` loss to "eventually charged" (blocker BILL-4).
2. **Org-scoped balance hint + org-level invalidation** (`OrgBalanceHint`,
   `iac:org-balance:<orgId>:v1`, TTL 15s) — the gate reads the org balance, not a
   per-credential value. On any failed/over-drawn debit the hint is invalidated
   so the next request re-reads fresh (blocker BILL-2).
3. **Uncollected-overage handling:** the DB `CHECK(credit_balance >= 0)` means a
   failed deferred debit does NOT go negative — `deductCredits` returns
   `success:false`. On failure we log the uncollected amount for alerting,
   invalidate the org-balance hint, and invalidate the user's IAC
   (`invalidateInferenceContextForUser`) — forcing the org back onto the
   synchronous-reserve slow path, which then returns the exact `402` until they
   top up. So a failed debit is bounded over-spend (the in-flight call only),
   never free-forever, and self-heals on top-up (blocker BILL-1). A persistent
   debt ledger would need a migration and is intentionally NOT added (logged
   instead) — out of scope for the optimistic-billing MVP.
4. **Idempotent settlement** keyed on `requestId`: the inline settler atomically
   CLAIMS the pending entry via `cache.getAndDelete` before debiting, and the
   cron sweep claims the same way — so the two can never both charge one request
   (BILL-minor). Residual: the claim is a near-atomic KV get-then-delete; a crash
   between claim and debit loses a single charge (under-bill, never double-bill).
5. **Fail-safe threshold:** `resolveSafeBalanceThresholdUsd` returns `+Infinity`
   (everyone slow-path) on unset/blank/non-finite/non-positive
   `SAFE_BALANCE_THRESHOLD`, never 0 (blocker BILL-5). The gate
   (`isOptimisticEligible`) requires `balance > threshold && balance > estimate`
   from a freshly-read balance (15s hint, not the 600s `user.withOrg` snapshot)
   (CS-1).
6. **Settler-shape parity:** `createOptimisticDebitSettler` returns the SAME
   `(actualCost) => Promise<CreditReconciliationResult|null>` shape as the
   reservation settler, so the route's single post-response `settleReservation`
   chain is unchanged and covers both streaming and non-streaming paths (RB-5).
7. **Backend assertion:** the IAC fast path requires `cache.isAvailable()`; a
   degraded/memory/disabled cache forces the slow path (resolver returns
   `slow_path` with reason `cache_unavailable`), since invalidation is ineffective
   off the bound KV namespace (CS-5).

Tier 2 is billing-critical; its prod behavior (KV consistency, `waitUntil`
eviction) cannot be fully proven by unit tests, so it ships **default OFF**.
Enable in staging behind `INFERENCE_OPTIMISTIC_BILLING` with a conservative
`SAFE_BALANCE_THRESHOLD`, watch the `[InferenceBilling]` uncollected/sweep logs,
then prod.

---

## Appendix — blockers the review surfaced (and how Tier 2 addresses them)

- **BILL-1 / SEC-4:** `CHECK(credit_balance >= 0)` + `WHERE current_balance >=
  amount` ⇒ failed deferred debit = free inference, not negative balance; the
  "drain→invalidate→hard-block" chain never fires.
- **BILL-2:** per-credential IAC cannot bound org-level drain (multiple
  keys/sessions/app-path share one org balance).
- **BILL-3 / CS-1:** the fast-vs-safe gate would decide on a balance that is up
  to ~11 min stale (60s IAC over a 600s `user.withOrg` snapshot that credit
  deductions don't invalidate).
- **BILL-4:** `waitUntil` is best-effort; with no upfront reserve it's the only
  billing — eviction/error/abort ⇒ free + unrecorded.
- **BILL-5:** threshold parse fallback to 0 fails open.
- **SEC-1 / CS-2:** session-token IAC entries have no `userId→tokenHash` index ⇒
  un-invalidatable on ban/logout/expiry ⇒ restrict fast path to API keys.
- **SEC-2:** wallet auth is signature/timestamp-bound + fail-closed ⇒ not
  cacheable; exclude.
- **SEC-3:** `validateApiKey` 10-min positive cache ⇒ revoked-key exposure is
  10 min unless both caches cleared; existing `invalidateCache` doesn't touch IAC.
- **SEC-5:** resolver must never catch-and-default to a permissive context.
- **CS-3:** KV is eventually consistent; invalidation is best-effort; real bound
  is TTL + propagation (~2 min), so TTL is load-bearing.
- **CS-5:** module-level singleton CacheClient ⇒ invalidation only works on the
  bound KV namespace, not a per-isolate memory adapter; optimization is inert if
  cache is disabled in prod.
- **RB-1:** deleted. The auth-context resolver is now the default path; cache
  unavailable still falls back to the authoritative path before granting auth.
- **RB-2:** catalog skip must be pinned to the name-pattern allowlist (else empty-
  but-billed-output regression for a catalog-only-reasoning id).
- **RB-3:** IAC must store no `active/suspended` booleans — only cache fully-OK
  contexts; non-OK ⇒ slow path to preserve the 401/403/402 taxonomy.
- **RB-5:** streaming/non-streaming settlement parity.
- **RB-6:** preserve 429→403→402 ordering.

---

## Post-implementation adversarial review (round 2) — fixes + residuals

A second adversarial review of the shipped code surfaced 12 confirmed findings.
The high-confidence, contained ones were FIXED:

- **Free-on-cache-failure (HIGH):** `writePendingInferenceCharge` used a
  swallow-on-failure `cache.set`, so on a KV brownout / open circuit it no-op'd
  and the request forwarded with no recorded charge. FIXED: the optimistic branch
  now gates on `isOptimisticBackstopAvailable()` (`cache.isAvailable()`, NOT
  `supportsAtomicOperations()` — that is false on KV and would disable Tier 2 in
  prod) AND `writePendingInferenceCharge` now uses `setIfNotExists` to REPORT
  persistence; a non-durable backstop falls through to the synchronous reserve.
- **Auto-suspension didn't invalidate IAC (MED):** `updateUserModerationStatus`
  (the authoritative mutation behind chat/messages/A2A moderation) now drops the
  user's IAC when they cross into a blocking state (banned / ≥5 violations).
- **IAC invalidation fan-out (LOW):** async moderation invalidates the user's IAC
  when a blocking violation is detected, so the next request re-checks
  authoritatively.
- **Out-of-order hint raise (LOW):** the debit settler writes the org-balance
  hint lower-only (`lowerOrgBalanceHint`), so a late concurrent debit can never
  raise the gate value.
- **Sweep hardening (MED):** pending TTL widened to 60 min (40-min sweep window
  over the 20-min grace, survives cron hiccups); a best-effort single-flight lock
  guards against overlapping sweeps; a `capHit` is logged, never silently dropped.

Residuals that are INHERENT to a KV-backed backstop and require the **DB-backed
pending-charge + settlement ledger** (the documented next step) before enabling
at scale — these are bounded, not free-forever, and must be covered by a
conservative `SAFE_BALANCE_THRESHOLD` until then:

- **Concurrent in-flight overdraw (BILL-2 redux):** the gate has no per-org
  in-flight accounting, so a burst within the 15s hint window can collectively
  overdraw; the DB `CHECK(>=0)` then refuses the overdrawing debits (uncollected,
  logged) and the org is forced to the slow path. Bounded by the threshold; a
  hard bound needs atomic admission (DB or atomic counter — KV has neither).
- **Exactly-once settlement:** the inline-vs-sweep and sweep-vs-sweep claim is an
  atomic `getAndDelete` on Redis but a non-atomic get-then-delete on KV, so a
  rare double-bill is possible there; the lock narrows it. True exactly-once
  needs a DB unique constraint on `request_id`.
- **Sweep drain rate:** the sweep is bounded to `maxKeys` per run with no cursor
  continuation; a sustained backlog above that needs the age-ordered DB query.
- **Gate/pricing DB reads:** the gate still reads a fresh balance on a hint miss,
  and pricing lookups remain per-request — the "zero DB reads pre-forward" claim
  holds for AUTH+MODERATION (Tier 1), not for the billing gate (Tier 2).

The money-safety invariants (no double-charge under an atomic backend, no
free-forever on cache failure, fail-safe `+Inf` threshold, uncollected→slow-path)
are unit-tested; the residuals above are the explicit boundary of what unit tests
on the in-memory adapter can prove about the production KV backend.

---

## Tier 3 — DB-backed pending-charge + settlement ledger (IMPLEMENTED — flag-gated, default OFF)

The "documented next step" above is now built: a real database table
(`inference_pending_charges`, migration `0153`) that is the durable, exactly-once
replacement for the KV pending-charge backstop. It is selected by
`INFERENCE_BILLING_LEDGER="db"` (default `kv` = the KV backstop). Code lives in
`@/lib/services/inference-billing-ledger` (`admitInferenceChargeViaLedger`,
`createLedgerDebitSettler`, `sweepStalePendingInferenceChargesDb`,
`resolveInferenceBillingLedger`); the chat + embeddings routes admit through it
when the flag is `db`, and the `sweep-inference-charges` cron sweeps BOTH backends
every run.

> This design — like Tier 1/2 — was hardened by an adversarial review (5-lens,
> 3-vote verify). It surfaced that a first cut (single `FOR UPDATE` admission +
> non-transactional claim-then-debit) did **not** actually bound overdraw on real
> Postgres and could lose a charge on a crash between claim and debit. The
> mechanisms below are the corrected design; the review's confirmed findings and
> their fixes are catalogued in `.github/issue-evidence/9899-db-ledger.md`.

It closes the three KV-inherent residuals point-for-point:

1. **Hard concurrent-overdraw bound (was BILL-2 redux).** Admission runs inside a
   transaction that FIRST takes a per-org `pg_advisory_xact_lock`, THEN reads the
   org balance + the `SUM` of its still-`pending` charges and inserts a `pending`
   row only when `balance > threshold` AND `balance − in-flight ≥ estimate`. The
   advisory lock serializes admissions for one org, so each reads the in-flight
   `SUM` only after any concurrent admission has **committed** (READ COMMITTED
   takes a fresh snapshot per statement). A bare `SELECT … FOR UPDATE` on the org
   row is **not** sufficient — the in-flight `SUM` scans a *different* table and
   would read a stale MVCC snapshot, so two concurrent admissions both see the same
   pre-insert `SUM` and both admit. (Single-connection PGlite serializes and hides
   this; real multi-connection Postgres does not — which is why the lock is
   load-bearing.) In-flight is the live `SUM` of `pending` rows themselves, so it
   is self-correcting: a crashed/dropped settle leaves its row `pending` and still
   counted until the sweep settles it — no separate counter to drift.
2. **Exactly-once settlement, crash-safe.** The claim (`UPDATE … SET
   status='settled' WHERE request_id=$ AND status='pending' RETURNING`) and the
   actual debit run in **one transaction**. The `request_id` PK + the `pending`
   guard make the claim exactly-once (only one of {inline settler, cron sweep} can
   win), and because claim+debit commit together: (a) a crash between them ROLLS
   BACK the claim, leaving the row `pending` for the sweep to recover — **no lost
   charge**; and (b) no concurrent admission ever observes a claimed-but-undebited
   state — **no over-admit window**. The debit replicates the same atomic `FOR
   UPDATE` balance guard + `credit_transactions` row as `reserveAndDeductCredits`
   (so it can run inside the claim transaction — `deductCredits` cannot take an
   external transaction); cache invalidation fires post-commit. Because the claim
   is a true DB transition the cron needs **no** KV-style single-flight lock —
   overlapping sweeps and a racing inline settler are all safe.
3. **Age-ordered sweep drain + bounded growth.** The sweep selects `status='pending'
   AND enqueued_at < NOW() − interval(grace) ORDER BY enqueued_at ASC LIMIT batch`
   over a partial index and loops batches until empty (bounded by `maxBatches`,
   `log`-surfaced when hit) — no silent cap. The cutoff is computed **in SQL**
   against `NOW()` so it is timezone-consistent with the `NOW()`-written
   `enqueued_at` (a client-side ISO-`Z` string would skew under a non-UTC session
   timezone). The sweep also GCs terminal (`settled`/`uncollected`) rows older than
   a retention window, so a caller-supplied `request_id` cannot pin an immortal row
   and the table stays bounded.

A successful debit fires the SAME post-debit notifications every other billing
path does — low-credits email, auto-top-up check, and the waifu hosted-agent pause
webhook — via the shared `creditsService.notifyBalanceDecrease`, so an org draining
through optimistic inference still gets low-balance warnings (the ledger mutates
the balance with its own transactional SQL rather than through `deductCredits`, so
this parity is explicit, not inherited). `uncollected` is a first-class row state
(auditable) instead of log-only: a debit the DB refuses (would overdraw) marks the
row `uncollected`, drops the org-balance hint, and the org's NEXT admission reads
the now-depleted balance and self-heals onto the synchronous-reserve path (402).
Bounded over-spend, never free-forever.

The cron sweeps **both** backends (`db` + `kv`) on every run regardless of the
flag — each is idempotent and a cheap no-op when empty — so a flag flip (or
rollback) between a charge's admit-time and the next sweep cannot orphan its
pending row on the no-longer-selected backend.

What the ledger does NOT change: pricing lookups remain per-request, and the
admission still reads a balance — the Tier-2 caveat that "zero DB reads pre-forward"
holds for AUTH+MODERATION (Tier 1) and not for the billing gate still stands. The
win is correctness-at-scale, not a further latency cut.

> Known parity residual (shared with the KV backstop, NOT fixed here because it is
> a product-semantics question): when `billUsage` throws *after* the model produced
> billable output, the route's error path calls `settle(0)`, which claims the row
> and charges nothing — a bounded single-request under-bill. Fixing it (charge the
> estimate vs. leave for the sweep vs. treat as a free abort) needs a decision on
> abort billing; tracked as a follow-up, not a regression.

### Rollout (Tier 3)

Same soak-then-cutover discipline as Tier 1/2, and orthogonal to them
(`INFERENCE_BILLING_LEDGER` is independent of `INFERENCE_HOT_PATH_CACHE` and
`INFERENCE_OPTIMISTIC_BILLING`; the ledger still requires
`INFERENCE_OPTIMISTIC_BILLING="true"`). Default `""`/`kv` everywhere = no behavior
change. To cut over: ship migration `0153`, flip `INFERENCE_BILLING_LEDGER="db"`
in staging, drive load, watch `[InferenceLedger] uncollected inference charge`
and the sweep stats (`settled`/`skipped`/`capHit`), then flip prod. Revert =
flag back to `""` (the KV backstop is unchanged and still wired). The KV backstop
stays as the rollback target during the migration; once the DB ledger is soaked
in prod, the KV pending-charge path can be retired.

### Tests (Tier 3)

`packages/cloud/shared/src/lib/services/__tests__/inference-billing-ledger.test.ts`
drives the REAL SQL against in-process PGlite (the same honest pattern as
`credits-deduct-guard.test.ts`): admission (affordable / threshold gate / **hard
overdraw bound** via seeded in-flight rows / unknown org / `+Inf` threshold /
idempotent re-delivery / a concurrent burst that cannot collectively overdraw /
in-flight self-correction once a charge settles); settle (actual debit /
**exactly-once** double-settle no-op / `settle(0)` / **uncollected** under
`CHECK(>=0)`); sweep (stale-vs-young / inline-then-sweep no double-charge /
age-ordered multi-batch drain / **dropped-inline recovery** — a never-settled row
stays `pending` and the sweep recovers the estimate / **GC** of terminal rows past
retention). Because single-connection PGlite serializes, the burst test asserts the
*accounting* (in-flight ≤ balance); the HARD bound under multi-connection Postgres
is provided by the per-org advisory lock (a property of Postgres locking the unit
test documents but cannot exercise in PGlite). The migration file itself is applied
to PGlite and asserted (`inference-pending-charges-migration.test.ts`): table + PK
+ both partial indexes exist, and re-applying is idempotent. The cron route test
(`cron/sweep-inference-charges/route.test.ts`) asserts it sweeps **both** backends.
