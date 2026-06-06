# @elizaos/plugin-finances

Owner-facing finance dashboard for elizaOS: balance summary, transactions, and
recurring charges. Currently a scaffold landing the package in the workspace
so subsequent passes can migrate OWNER_FINANCES out of `@elizaos/plugin-lifeops`.

## Purpose / role

Surfaces the owner's finance state — accounts balance, recent transactions,
and recurring charges / subscriptions — as a dedicated overlay app and an
action callable from chat. Hooks into other finance providers (CSV import,
bank connectors, payment processors, etc.) in a later phase. The plugin is
opt-in; add `@elizaos/plugin-finances` to the agent's plugin list. It hard-
depends on `@elizaos/plugin-sql` (declared as a peer dep and in
`dependencies: ["@elizaos/plugin-sql"]`).

## Plugin surface

**Action**
- `OWNER_FINANCES` (`src/actions/finances.ts`) — **scaffold stub.** Returns a
  clear "not yet wired" `ActionResult`. The real handler is migrating from
  `plugins/plugin-lifeops/src/actions/owner-surfaces.ts` (`ownerFinancesAction`
  around line 433) plus the money / payments handlers in
  `plugins/plugin-lifeops/src/actions/money.ts` and
  `plugins/plugin-lifeops/src/actions/payments.ts`. Role gate: ADMIN.
  Contexts: `money`, `owner`.

**Views**
- `finances` — `FinancesView` component, path `/finances`, bundle
  `dist/views/bundle.js`. Three placeholder sections: balance summary,
  transactions, recurring charges. Backed by `FinancesViewProps` in
  `src/types.ts`.

**Schema**
- `financesSchema` (`pgSchema("app_finances")`) with two tables:
  - `transactionsTable` — agent / entity / occurredAt / amountMinor /
    currency / description / category / merchant / status / source / metadata.
  - `recurringChargesTable` — agent / entity / label / amountMinor /
    currency / cadence / nextChargeAt / merchant / active / metadata.
  Exported from `src/db/index.ts` as the drizzle schema object the runtime
  registers migrations from.

## Layout

```
src/
  index.ts                        Plugin default export + named re-exports
  plugin.ts                       Plugin object (action + views + schema wiring)
  types.ts                        DTOs and status / cadence enums
  actions/
    finances.ts                   ownerFinancesAction (scaffold stub)
  db/
    schema.ts                     pgSchema("app_finances") + transactions / recurring tables
    index.ts                      re-exports schema.ts
  components/
    finances/
      FinancesView.tsx            Placeholder dashboard view (3 sections)
      finances-view-bundle.ts     Vite view-bundle entry (named FinancesView export)
```

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

No env vars or settings keys yet. When OWNER_FINANCES is migrated from
plugin-lifeops, any required env vars (CSV source paths, finance connector
tokens, etc.) will be documented here.

## Migration map from `@elizaos/plugin-lifeops`

| Symbol / file | Source in plugin-lifeops | Destination |
|---|---|---|
| `ownerFinancesAction` | `src/actions/owner-surfaces.ts` (~line 433) | `src/actions/finances.ts` |
| `OWNER_FINANCE_ACTIONS`, `OWNER_FINANCE_SIMILES` | `src/actions/owner-surfaces.ts` | `src/actions/finances.ts` (TODO) |
| `MONEY_PARAMETERS`, `runMoneyHandler` | `src/actions/money.ts` | `src/actions/finances.ts` (TODO) |
| Recurring-charge helpers | `src/actions/payments.ts`, `src/actions/lib/payments-recurring.ts` (if present) | `src/actions/finances.ts` / future `src/lib/` (TODO) |
| Finance dashboard view | currently rendered through `LifeOpsPageView` | `src/components/finances/FinancesView.tsx` |
| Finance DB tables | lifeops `src/lifeops/schema.ts` finance sections | `src/db/schema.ts` |

When the OWNER_FINANCES code is moved over here, delete the corresponding
exports from `plugin-lifeops/src/actions/owner-surfaces.ts` and update the
`promoteSubactionsToActions` wiring in `plugin-lifeops/src/plugin.ts`.

## How to extend

**Add a sub-op to OWNER_FINANCES:**
1. Add the op name to the action's `enum` for the `action` parameter in
   `src/actions/finances.ts`.
2. Add the case in the (migrated) handler dispatch.
3. Surface any new DTO field in `src/types.ts` so `FinancesView` can render
   it.

**Add a finance provider integration (bank / CSV / payments):**
1. Add a `src/providers/<name>.ts` exporting a `Provider` from
   `@elizaos/core`.
2. Register it in the `providers` array of `financesPlugin` in
   `src/plugin.ts`.

**Add a new view variant (XR / TUI):**
1. Build the component under `src/components/finances/`.
2. Re-export it from `finances-view-bundle.ts`.
3. Add a view descriptor to the `views` array in `src/plugin.ts` with a
   unique `viewType`.

## Conventions / gotchas

- **`@elizaos/plugin-sql` must be loaded first.** The drizzle schema is
  registered through the `schema` field; the SQL plugin owns the migration
  runner. Without it, the tables will not be created.
- **Two build steps.** The JS/types build (tsup + tsc) and the Vite views
  build are separate. The views bundle (`dist/views/bundle.js`) is what the
  `bundlePath` in the view registration points to.
- **Scoping is `(agentId, entityId)`.** Transactions and recurring charges
  are per-owner per-agent.
- **Action handler is currently a stub.** Migration from
  `@elizaos/plugin-lifeops` is intentionally deferred. Do not add real
  business logic here until the migration pass starts.
- **Currency amounts are stored as minor units (cents) in `amountMinor`.**
  Never mix major/minor units; convert at the render boundary.
- See the root `AGENTS.md` for repo-wide architecture rules, logger
  requirements, ESM/module standards, and git workflow.
