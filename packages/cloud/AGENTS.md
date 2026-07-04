# packages/cloud — agent guide

Eliza Cloud: the multi-tenant Worker (`api/`) + shared services (`shared/src/lib/`) behind api.elizacloud.ai + the console/app Pages. Money-moving + multi-tenant, so correctness and isolation are load-bearing.

## Deploy pipeline (hard-won — read before touching prod)

- **Vehicle:** `.github/workflows/cloud-cf-deploy.yml`. A **push** deploys **staging** (`develop`→staging); **prod** deploys from **`main`** only.
- **The `production` GitHub Environment allows ONLY the `main` branch** (`custom_branch_policies:["main"]`) **and has `required_reviewers`.** A `workflow_dispatch --ref develop -f environment=production` is **rejected at the migrate-db job setup** (2-sec, zero-steps failure). So: ship prod from a **main push** or `--ref main -f environment=production`, never develop.
- **`migrate-db` gate:** every deploy job `needs: migrate-db`, which runs prod DB migrations on `ubuntu-latest` and **pauses for a prod-env reviewer**. Authorized reviewers: standujar / lalalune / NubsCarson / 0xSolace. Approve via `POST /repos/elizaOS/eliza/actions/runs/<id>/pending_deployments` with JSON `{environment_ids:[<env.id>],state:"approved"}`. Fail-closed: a failed migration blocks the deploy (never ships against a stale schema).
- **Install config:** bun pinned to `latest` (NOT `canary` — canary's link phase hangs on the box), install cache on **local `$HOME`** (NOT `$PWD`, which is on the box's slow `/tmp`), `BUN_INSTALL_TIMEOUT` 2400s. If install hangs anyway, it's the self-hosted box FS (Stan's), not the config.
- **Runner lottery:** deploy jobs intermittently die at `Checkout repository` ("The operation was canceled") on flaky hetzner-robot runners while sibling jobs succeed. Fix = `gh run rerun <id> --failed` to re-roll just the failed job onto a healthy runner.
- **Do NOT re-dispatch into a saturated queue** (a 200-PR CI day starves the hosted pool); the zombie janitor + drain clear it. Sweep stale in_progress zombies via the REST field **`.id`** (NOT `.databaseId` — that's `gh run list`'s field), filtered by `run_started_at`, but never cancel the live deploy run.
- **develop→main promote** brings the reviewed integration branch to prod; the only recurring conflict is `cloud-cf-deploy.yml` itself (multi-agent-contested) — resolve to develop's version.

## Money invariants (the correctness bar)

- **Debit before the irreversible action, fail-closed.** e.g. domain buy: `deductCredits()` → check `.success` → 402 **before** registering; refund on registrar failure. Never discard `.success`.
- **Idempotency everywhere.** Stripe events (`stripe:<type>:<id>`), creator earnings (leg-keyed `<chargeKey>:<type>:<leg>` ALS key across all money routes), reservation reconcile (`recon:<txid>:<phase>`), crypto top-up (payment-intent). A retry must never double-credit or double-pay.
- **Credit holds:** `reserveAndDeductCredits` is an atomic CTE with `SELECT … FOR UPDATE` + `WHERE current_balance >= amount`. Reserve upfront against the real output cap, reconcile after.
- **Clawback stays non-negative + delta-based;** won-dispute reinstatements must net against `getClawedBackUsdForPaymentIntent`.
- **Crypto direct-wallet:** EIP-712 payer-proof binds `tx.from`/Transfer-event to the caller-chosen `payerAddress` (token + native + Solana). x402 gates the **signed** `authorization.value`, never the client-echoed `accepted.amount`.
- **Payouts (Stripe Connect):** the `account.updated` webhook must persist `charges_enabled`/`payouts_enabled` (the transfer gate reads the column); idempotent debit; fail-closed availability.

## Auth / multi-tenancy

- **Global default-deny gate** (`api/src/middleware/auth.ts`): a path is reachable unauthenticated ONLY if on the `isPublicPath()` allowlist. `X-API-Key`/`Bearer eliza_*`/`X-Service-Key` bypass the gate and must be validated per-route.
- **Gated ≠ owned:** the gate proves *some* logged-in user, not ownership. Every by-id/list route must scope by `organization_id`/`user.id`/an ownership check (e.g. `getByIdForUser`). Public data/action routes must self-authenticate.
- Platform a2a RPC (public) authorizes per-capability via `authorizeCapability` (requireAdmin / public-only / requireUserOrApiKeyWithOrg).

## Tests

Money paths have real coverage (`api/__tests__/*credit*|*billing*|*stripe*|*payout*` + `api/test/e2e/group-*`); the PGlite proofs run for real in CI (#11078). When touching a money path, add/extend the matching test — a green CI without a money test is not "tested".

## Discipline

Money/security/client-coupled changes: file + coordinate on the tracker boards (#8434 launch, #10561 board, #11157 charter), don't solo-merge into the maintainer's lane; self-merge only your own CI/infra fixes. Never fake tests. There are real external users — don't break prod.
