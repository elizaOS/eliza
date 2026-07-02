# packages/cloud - agent guide

Eliza Cloud: the multi-tenant Worker (`api/`) plus shared services (`shared/src/lib/`) behind api.elizacloud.ai and the console/app Pages. Money-moving and multi-tenant, so correctness and isolation are load-bearing.

## Deploy pipeline

- **Vehicle:** `.github/workflows/cloud-cf-deploy.yml`. A push deploys staging (`develop` -> staging); prod deploys from `main` only.
- **The `production` GitHub Environment allows only the `main` branch** (`custom_branch_policies:["main"]`) and has required reviewers. A `workflow_dispatch --ref develop -f environment=production` is rejected at the migrate-db job setup. Ship prod from a main push or `--ref main -f environment=production`, never develop.
- **`migrate-db` gate:** every deploy job `needs: migrate-db`, which runs prod DB migrations on `ubuntu-latest` and pauses for a prod-env reviewer. Authorized reviewers: standujar / lalalune / NubsCarson / 0xSolace. Approve via `POST /repos/elizaOS/eliza/actions/runs/<id>/pending_deployments` with JSON `{environment_ids:[<env.id>],state:"approved"}`. Fail closed: a failed migration blocks the deploy.
- **Install config:** Bun is pinned to `latest`, not `canary`; canary's link phase hangs on the box. Install cache belongs on local `$HOME`, not `$PWD`, which is on the box's slow `/tmp`. `BUN_INSTALL_TIMEOUT` is 2400s. If install hangs anyway, suspect the self-hosted box filesystem.
- **Runner lottery:** deploy jobs intermittently die at `Checkout repository` with "The operation was canceled" on flaky hetzner-robot runners while sibling jobs succeed. Fix with `gh run rerun <id> --failed` to reroll just the failed job.
- **Do not re-dispatch into a saturated queue.** A 200-PR CI day starves the hosted pool; the zombie janitor and drain clear it. Sweep stale `in_progress` zombies via the REST field `.id`, not `.databaseId`, filtered by `run_started_at`, but never cancel the live deploy run.
- **develop -> main promote** brings the reviewed integration branch to prod. The recurring conflict is `cloud-cf-deploy.yml`; resolve to develop's version.

## Money invariants

- **Debit before the irreversible action, fail closed.** For example, domain buy: `deductCredits()` -> check `.success` -> 402 before registering; refund on registrar failure. Never discard `.success`.
- **Idempotency everywhere.** Stripe events (`stripe:<type>:<id>`), creator earnings (leg-keyed `<chargeKey>:<type>:<leg>` ALS key across all money routes), reservation reconcile (`recon:<txid>:<phase>`), crypto top-up (payment-intent). A retry must never double-credit or double-pay.
- **Credit holds:** `reserveAndDeductCredits` is an atomic CTE with `SELECT ... FOR UPDATE` plus `WHERE current_balance >= amount`. Reserve upfront against the real output cap, reconcile after.
- **Clawback stays non-negative and delta-based.** Won-dispute reinstatements must net against `getClawedBackUsdForPaymentIntent`.
- **Crypto direct-wallet:** EIP-712 payer proof binds `tx.from` / Transfer-event to the caller-chosen `payerAddress` for token, native, and Solana. x402 gates the signed `authorization.value`, never the client-echoed `accepted.amount`.
- **Payouts (Stripe Connect):** the `account.updated` webhook must persist `charges_enabled` / `payouts_enabled`; the transfer gate reads the column. Debits must be idempotent and availability must fail closed.

## Auth / multi-tenancy

- **Global default-deny gate** (`api/src/middleware/auth.ts`): a path is reachable unauthenticated only if on the `isPublicPath()` allowlist. `X-API-Key` / `Bearer eliza_*` / `X-Service-Key` bypass the gate and must be validated per route.
- **Gated is not owned:** the gate proves some logged-in user, not ownership. Every by-id/list route must scope by `organization_id`, `user.id`, or an ownership check such as `getByIdForUser`. Public data/action routes must self-authenticate.
- Platform a2a RPC routes are public but authorize per capability via `authorizeCapability` (`requireAdmin`, public-only, or `requireUserOrApiKeyWithOrg`).

## Tests

Money paths have real coverage in `api/__tests__/*credit*|*billing*|*stripe*|*payout*` and `api/test/e2e/group-*`; the PGlite proofs run for real in CI. When touching a money path, add or extend the matching test. A green CI without a money test is not tested.

## Discipline

Money, security, and client-coupled changes: file and coordinate on the tracker boards (#8434 launch, #10561 board, #11157 charter). Do not solo-merge into the maintainer's lane; self-merge only your own CI/infra fixes. Never fake tests. There are real external users; do not break prod.
