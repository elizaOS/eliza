# Example-apps showcase coverage (#9300)

Continuous, always-green proof that our two flagship monetized example apps -
**EDAD** (`packages/examples/cloud/edad`) and **Clone Ur Crush**
(`packages/examples/cloud/clone-ur-crush`) - work end to end on Eliza Cloud,
exercised by a dedicated **CI showcase account** with effectively-infinite
credits. It continuously drives the cloud monetization system
(app registration -> container deploy -> app subdomain -> usage/billing -> creator
monetization -> redeemable earning) so it can never silently rot.

## The spec

[`tests/example-apps-showcase.spec.ts`](../tests/example-apps-showcase.spec.ts)
runs, for **each** app, with an explicit assertion at every hop:

| # | Hop | What is asserted (real code path) |
| --- | --- | --- |
| 1 | register app | `POST /api/v1/apps` returns an app id. |
| 2 | deploy container | a control-plane provision job stands a Hetzner **mock** node up (`initializing -> running`, observable server-count +1) AND a real `containers` row is bound to the app (`project_name = appId`) via `containersRepository.create`. |
| 3 | **app subdomain** configured + live | the container's `public_hostname` is the real `<shortid>.apps.elizacloud.ai` (`deriveAppPublicUrl`), and the Caddy on-demand-TLS gate `GET /api/v1/apps-ingress/ask?domain=<host>` authorizes a cert for the live host (**200**) while refusing an unknown host (**404**). This is the app link being wired + ready to serve TLS. |
| 4 | enable monetization | `PUT /api/v1/apps/:id/monetization` (markup + purchase share); `GET` reads back `monetizationEnabled: true`. |
| 5 | **monetized transaction** | the showcase org is debited the full base+markup charge through the real per-app billing service (`appCreditsService.deductCredits`); the balance moves by exactly `base + computed markup`. |
| 6 | usage -> creator earning | the app's inference markup is recorded to BOTH the app-scoped earnings ledger (`appEarningsRepository.addInferenceEarnings`; `GET /api/v1/apps/:id/earnings` summary climbs by exactly the computed markup) AND the creator's REDEEMABLE balance (`redeemableEarningsService.addEarnings`, source `app_owner_revenue_share`). |
| 7 | redeemable / payout-ready | `GET /api/v1/redemptions/balance` reflects the accrued, withdrawable earning. |

Account-level invariants the showcase exists to guarantee:

- **login / auth gate** - an unauthenticated `GET /api/v1/credits/balance` is
  `401/403`; the showcase key's read is `200`. (The apps sign users in before
  they can spend; this proves the gate.)
- **infinite credits** - after every charge the balance is still >= the grant, so
  the account never runs dry mid-run - yet each charge moved the **real** ledger
  (each app asserts its own exact debit).
- **one account, both apps** - the single showcase creator's redeemable balance
  equals the SUM of both apps' markups, each recorded under its own `appId`, on
  distinct subdomains.

The Stripe Connect fiat payout (the cash-out half of "creator monetization") is
exercised by [`monetized-full-loop.spec.ts`](../tests/monetized-full-loop.spec.ts)
(`#8922`), which the nightly runs alongside this spec.

## The CI showcase account (infinite credits)

Seeded by [`src/helpers/showcase.ts`](../src/helpers/showcase.ts)
(`seedShowcaseAccount`):

- **How it's funded.** Through the **real** billing code path -
  `creditsService.addCredits` grants `$1,000,000` to the org `credit_balance`
  and writes a real `credit_transactions` row. There is **no** "skip billing"
  branch: every monetized transaction still runs `deductCredits` against the same
  `FOR UPDATE` ledger a paying customer hits. "Infinite" means a real balance so
  large a run (which spends cents) never exhausts it - so the billing pipeline we
  most want to keep green is the one actually exercised.
- **How it's isolated from real revenue** (two layers, both observable):
  1. **Ephemeral DB** - the mock-stack loop runs against an in-process PGlite DB
     created and torn down per run. There is no shared store, so nothing it
     writes can touch production revenue.
  2. **Tagged ledger + reserved namespace** - every grant is stamped with
     `{ type: "showcase_seed", account: "ci-showcase", isolated: true, issue: 9300 }`
     and the account uses the reserved `@ci-showcase.elizacloud.test` email
     namespace and `ci-showcase-` slug prefix, so revenue reporting CAN exclude
     showcase activity by that tag/namespace - auditable + excludable, not silently
     mixed into real numbers. (Adding that exclusion filter to the real revenue
     dashboard is the operator step when the real-staging account is provisioned -
     the tag is already emitted, so it is a query filter, not a schema change.)

## Where it runs

- **Per-PR (active).** [`cloud-e2e.yml`](../../../../.github/workflows/cloud-e2e.yml)
  runs `bun run cloud:e2e`, which globs every
  `packages/test/cloud-e2e/tests/*.spec.ts` - so this spec runs on every PR that
  touches `packages/cloud-*/**` or `packages/test/**`.
- **Nightly (active, mock).** The `showcase-mock` job in
  [`monetized-loop-nightly.yml`](../../../../.github/workflows/monetized-loop-nightly.yml)
  drives this spec + the monetized full loop against the mock stack on a schedule
  with **no secrets**, so the loop stays green even when no PR touches the cloud
  paths (e.g. a dependency bump). Uploads Playwright report + video + logs.
- **Nightly (scaffold, real Hetzner).** The `loop` job sets
  `MONETIZED_LOOP_REAL=1`, under which the mock showcase spec skips at the
  describe level and the real deploy drivers run. It activates the moment the
  live-staging driver + secrets
  (`HCLOUD_TOKEN_CI`, `CLOUD_E2E_API_KEY` for the real showcase account) exist -
  see below. Until then it honest-skips (green-but-skipped); it never passes a
  mock assertion off as real.

## Running locally (mock stack)

```bash
# just the showcase loop
bun run cloud:e2e -- example-apps-showcase.spec.ts

# showcase + monetized full loop (what the nightly mock job runs)
bun run cloud:e2e -- example-apps-showcase.spec.ts monetized-full-loop.spec.ts
```

Relevant env (defaulted by `src/fixtures/env.ts`): `MOCK_HETZNER_ACTION_MS`
(server transition window), `CONTROL_PLANE_TICK_MS`, `ELIZA_CF_REGISTRAR_DEV_STUB`.
The spec sets `CONTAINERS_PUBLIC_BASE_DOMAIN=apps.elizacloud.ai` for its own
process (with save/restore) so `deriveAppPublicUrl` yields the production
subdomain shape.

## Activating the real-staging loop (follow-up, operator)

The live deploy moves real Hetzner capacity and credits and is intentionally
operator-gated. To activate the `loop` job for the showcase account:

1. **Provision the real showcase account.** Create a dedicated Eliza Cloud org on
   staging using the reserved namespace (e.g. `ci-showcase@ci-showcase.elizacloud.test`).
   Fund it via the real credit-grant path (`creditsService.addCredits`, or the
   admin credit-grant route) and confirm the grant carries the showcase metadata
   tag so revenue reporting excludes it.
2. **Seed CI secrets** in the `ci-hetzner-e2e` GitHub environment: `HCLOUD_TOKEN_CI`
   (CI-scoped Hetzner project) and `CLOUD_E2E_API_KEY` (the showcase account's
   long-lived bearer token). Optionally set `MONETIZED_LOOP_BASE_URL`.
3. **Arm the normal app deploy builder.** The real drivers do not pin operator
   images. They register apps over HTTP, then call
   `POST /api/v1/apps/:id/deploy` with the repo URL, ref, and app Dockerfile the
   same way an agent-built app using the Eliza Cloud app path would. On the
   provisioning daemon, set:
   - `APPS_IMAGE_REGISTRY` to the registry namespace where freshly built app
     images are pushed.
   - `APPS_BUILD_FROM_REPO_ENABLED=1`.
   - `APPS_BUILDS_HOST` to a dedicated builder host that is logged in to the
     registry and supports `docker buildx` with the `docker-container` driver.
     If there is no dedicated host, `APPS_BUILD_ON_RUNTIME_NODE=1` is an explicit
     operator opt-in to build on the runtime node.

   Also put the showcase org in `APPS_DEPLOY_ALLOWED_ORG_IDS` with
   `APPS_DEPLOY_ENABLED=1`.
4. **The real-mode driver (slice 1 — landed).**
   [`tests/example-edad-real-deploy.spec.ts`](../tests/example-edad-real-deploy.spec.ts)
   and
   [`tests/example-clone-ur-crush-real-deploy.spec.ts`](../tests/example-clone-ur-crush-real-deploy.spec.ts)
   are pure-HTTP deploy-and-serve drivers. They honest-skip at the describe level
   unless `MONETIZED_LOOP_REAL=1` + `MONETIZED_LOOP_BASE_URL` + `CLOUD_E2E_API_KEY`
   are all set (so per-PR / mock CI never reaches live staging), and otherwise:
   auth-preflight the showcase key, register the app, deploy via the real
   `POST /deploy` route with `repoUrl`, `ref`, and `dockerfile`, poll
   `GET /deploy/status` to READY (real ~5s cadence, ~10min cap, **no** mock
   control-plane tick), then assert the app flips to deployed/remote, its
   `*.apps.elizacloud.ai` `production_url` **actually serves** the app's own UI,
   and the ingress on-demand-TLS `ask` gate authorizes the live host — with
   **guaranteed teardown** (`DELETE /api/v1/apps/:id` full cleanup) in a
   `finally` so a real run leaves no orphan billable container. The mock showcase
   spec above is unchanged (it already skips itself when `REAL=1`).
5. **The monetized half (slice 2 — follow-up).** Drive a real charge → app
   earning → redeemable through real HTTP routes (the mock spec drives this
   in-process via `appCreditsService.deductCredits`; a real driver must push it
   through a route). Tracked as a #9300 follow-up, separate PR.

The contract is the same either way: every hop above must be asserted against
real data, and a failure must surface loudly in CI with logs + screenshots +
video.
