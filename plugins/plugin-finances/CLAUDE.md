# @elizaos/plugin-finances

Owner-facing finance back-end + dashboard for elizaOS: payment sources, bank /
PayPal / Plaid / CSV transactions, spending summaries, recurring-charge
detection, and email bills. Owns the finance data layer (`FinancesService` +
`FinancesRepository` over the `app_finances` schema) that
`@elizaos/plugin-personal-assistant` (PA) delegates to.

## Purpose / role

Surfaces the owner's finance state — payment sources, recent transactions,
recurring charges, spending, and email bills — as a dedicated overlay app, and
provides the payments back-end the agent's OWNER_FINANCES action drives. The
plugin is opt-in; add `@elizaos/plugin-finances` to the agent's plugin list (PA
auto-registers it via `ensureLifeOpsFinancesPluginRegistered`). It hard-depends
on `@elizaos/plugin-sql` (peer dep + `dependencies: ["@elizaos/plugin-sql"]`),
and on `@elizaos/plugin-elizacloud` for the managed Plaid / PayPal clients.

## Plugin surface

**Back-end (the finance domain home)**
- `FinancesService` (`src/finances-service.ts`) — payment sources, CSV import,
  transactions, spending summaries, recurring-charge detection, email bills,
  and the Plaid / PayPal managed bridges. Standalone successor to PA's
  `withPayments` mixin; holds its own runtime + `FinancesRepository`. Throws
  `FinancesServiceError` (HTTP status) on invalid input.
- `FinancesRepository` (`src/db/finances-repository.ts`) — raw SQL over
  `app_finances` (payment sources / transactions + subscription audits /
  candidates / cancellations). Uses the self-contained `src/db/sql.ts` helpers
  (runtime DB handle). PA's `LifeOpsRepository` delegates its finance methods
  here so the PA subscriptions mixin reaches the finance tables unchanged.
- `SubscriptionsService` (`src/services/subscriptions-service.ts`) — standalone
  successor to PA's `withSubscriptions` mixin. Handles subscription audit /
  cancellation; reaches Gmail via `SubscriptionsGmailGateway`
  (`src/services/gmail-seam.ts`) and the browser bridge via
  `SubscriptionsBrowserGateway` (`src/services/browser-bridge-seam.ts`) through
  runtime-service seams instead of PA internals.
- `runPaymentsHandler`, `MONEY_PARAMETERS`, `OWNER_FINANCE_SIMILES`,
  `MONEY_TAGS`, `MONEY_CONTEXTS` (`src/actions/finances.ts`) — the payments
  OWNER_FINANCES dispatch + parameter schema. PA imports these; the registered
  `OWNER_FINANCES` umbrella action stays in PA because it also routes
  `subscription_*` to PA's Gmail/browser-orchestrating subscription back-end.

**Views**
- `finances` — `FinancesView` component, path `/finances`, bundle
  `dist/views/bundle.js`. Fetches the four `/api/lifeops/money/*` GET routes
  (dashboard / sources / transactions / recurring), served by PA's route layer
  via `runFinancesRoute` → `FinancesService`. URLs + response shapes are stable.

**Schema** (`financesSchema` = `pgSchema("app_finances")`, registered via the
plugin `schema` field; the SQL plugin owns the migration runner)
- `lifePaymentSources`, `lifePaymentTransactions`, `lifeSubscriptionAudits`,
  `lifeSubscriptionCandidates`, `lifeSubscriptionCancellations`. Table NAMES are
  preserved verbatim from the original LifeOps tables (`life_payment_*`,
  `life_subscription_*`) so the non-destructive copy migration
  (`FinancesMigrationService`) can move existing `app_lifeops` rows across.
  Amounts are stored in USD (`amount_usd` real), not minor units.

## Layout

```
src/
  index.ts                        Plugin default export + named re-exports
  plugin.ts                       Plugin object (views + schema + migration)
  types.ts                        View DTOs (FinancesViewProps etc.)
  finances-service.ts             FinancesService (payments back-end)
  finance-normalize.ts            FinancesServiceError + input normalizers
  payment-types.ts                Payment / dashboard / spending types
  payment-recurrence.ts           Recurring-charge detection + merchant normalize
  payment-csv-import.ts           CSV parser → ParsedCsvTransaction
  token-encryption.ts             AES-256-GCM token-at-rest helpers
  subscriptions-types.ts          Subscription audit / candidate / cancellation types
  subscriptions-playbooks.ts      Cancellation playbooks (Netflix, Spotify, …)
  actions/
    finances.ts                   runPaymentsHandler + OWNER_FINANCES param schema
  db/
    schema.ts                     pgSchema("app_finances") + 5 finance tables
    sql.ts                        Self-contained raw-SQL helpers (runtime DB)
    finances-repository.ts        FinancesRepository (raw SQL over app_finances)
    index.ts                      re-exports schema.ts
  services/
    migration.ts                  FinancesMigrationService (app_lifeops → app_finances copy)
    subscriptions-service.ts      SubscriptionsService (subscription audit / cancellation back-end)
    browser-bridge-seam.ts        SubscriptionsBrowserGateway runtime-service seam
    gmail-seam.ts                 SubscriptionsGmailGateway runtime-service seam
  components/
    finances/
      FinancesView.tsx            Dashboard view (fetches /api/lifeops/money/*)
      finances-view-bundle.ts     Vite view-bundle entry (named FinancesView export)
```

## Boundary with plugin-personal-assistant

- `@elizaos/plugin-finances` MUST NOT import `@elizaos/plugin-personal-assistant`.
- PA delegates the payments back-end here (routes via `runFinancesRoute` →
  `FinancesService`; `actions/payments.ts` re-exports `runPaymentsHandler`).
- **Subscription audit / cancellation lives in `SubscriptionsService`**
  (`src/services/subscriptions-service.ts`), a standalone successor to PA's
  `withSubscriptions` mixin. It reaches cross-domain surfaces through
  runtime-service seams (`gmail-seam.ts` via `@elizaos/plugin-google`,
  `browser-bridge-seam.ts` via `@elizaos/plugin-browser`) rather than PA
  internals, so it carries no PA dependency.

## Commands

```bash
bun run --cwd plugins/plugin-finances typecheck    # tsc --noEmit
bun run --cwd plugins/plugin-finances lint         # biome check src/
bun run --cwd plugins/plugin-finances test         # vitest run
bun run --cwd plugins/plugin-finances build        # build:js + build:views + build:types
bun run --cwd plugins/plugin-finances build:js     # tsup (shared config)
bun run --cwd plugins/plugin-finances build:views  # vite build for overlay bundle
bun run --cwd plugins/plugin-finances build:types  # tsc declaration emit
bun run --cwd plugins/plugin-finances clean        # rm -rf dist
```

## Config / env vars

| Variable | Required | Description |
|---|---|---|
| `ELIZA_TOKEN_ENCRYPTION_KEY` | No | 32-byte (base64/hex) key encrypting Plaid / PayPal tokens at rest. Falls back to a lazily-generated `<oauth-dir>/lifeops/payments/.encryption-key` (mode 0600). |
| `ELIZAOS_CLOUD_API_KEY` | No | Eliza Cloud API key for the managed Plaid / PayPal bridges. |
| `ELIZAOS_CLOUD_BASE_URL` | No | Eliza Cloud base URL override for the managed bridges. |

## What lives here vs. in PA

| Concern | Home |
|---|---|
| Payment back-end (`FinancesService`) + repository (`FinancesRepository`) | plugin-finances |
| Finance schema (`app_finances`) + migration | plugin-finances |
| Payment / subscription types, recurring detection, CSV parse, token crypto, playbooks | plugin-finances |
| `runPaymentsHandler` + OWNER_FINANCES param schema / similes | plugin-finances (`src/actions/finances.ts`) |
| Subscription audit / cancellation (`SubscriptionsService`) | plugin-finances (`src/services/subscriptions-service.ts`) |
| Registered `OWNER_FINANCES` umbrella action + `runMoneyHandler` dispatch | PA (`owner-surfaces.ts` / `money.ts`) — routes `subscription_*` to PA |
| `/api/lifeops/money/*` routes | PA (`lifeops-routes.ts`, `runFinancesRoute` → `FinancesService`) |

## How to extend

**Add a payments sub-op:**
1. Add the subaction to `PaymentsSubaction` + `MONEY_PARAMETERS` and the
   `switch` in `runPaymentsActionInner` (`src/actions/finances.ts`).
2. Add the method to `FinancesService` (`src/finances-service.ts`); add any new
   raw-SQL access to `FinancesRepository` (`src/db/finances-repository.ts`).
3. If it needs a route, add it under `/api/lifeops/money/*` in PA's
   `lifeops-routes.ts` using `runFinancesRoute`.

**Add a finance provider integration (bank / CSV / payments):**
1. Add a method to `FinancesService` (and `FinancesRepository` for persistence).
2. For OAuth/managed bridges, follow the Plaid / PayPal pattern via
   `@elizaos/plugin-elizacloud/cloud/managed-payment-clients`.

**Add a new view variant (XR / TUI):**
1. Build the component under `src/components/finances/`.
2. Re-export it from `finances-view-bundle.ts`.
3. Add a view descriptor to the `views` array in `src/plugin.ts`.

## Conventions / gotchas

- **`@elizaos/plugin-sql` must be loaded first.** The drizzle schema is
  registered through the `schema` field; the SQL plugin owns the migration
  runner. Without it, the tables will not be created.
- **Two build steps.** The JS/types build (tsup + tsc) and the Vite views
  build are separate. The views bundle (`dist/views/bundle.js`) is what the
  `bundlePath` in the view registration points to.
- **Scoping is per-agent** (`agent_id`); the route/service derive the owner
  entity from the request context.
- **Currency amounts are stored in USD** (`amount_usd` real), not minor units.
- **No import of `@elizaos/plugin-personal-assistant`.** Cross-domain capability
  the finance back-end needs (Gmail, browser bridge) is accessed via runtime-service
  seams, not PA internals.
- **`src/db/sql.ts` is a self-contained copy** of PA's raw-SQL helpers (so the
  back-end carries no PA dependency). Keep it in sync only if a correctness fix
  applies to both; do not add PA-specific logic.
- See the root `AGENTS.md` for repo-wide architecture rules, logger
  requirements, ESM/module standards, and git workflow.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — wallet / chain / contracts:**
- On-chain transaction hash(es) + explorer link, wallet balance **before and after**, and the signed-payload/log trail — run against a testnet or fork.
- Revert / insufficient-funds / nonce / gas-estimation-failure paths, and signature-authorization (role/permission) checks.
- The decision trajectory when an agent initiated the on-chain action.
- Never a mocked RPC asserted green — prove the chain state actually changed.
<!-- END: evidence-and-e2e-mandate -->
