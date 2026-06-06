# @elizaos/plugin-finances

Owner-facing finance dashboard for elizaOS: balance summary, transactions, and recurring charges.

## Status

**Scaffold.** Part of the `refactor/lifeops-decomposition` series. The
package is wired into the workspace and compiles standalone, but the action
implementation is a stub — see the migration map below for where the real
code currently lives.

## Plugin surface

- **Action**
  - `OWNER_FINANCES` (`src/actions/finances.ts`) — scaffold; returns a clear
    "not yet wired" `ActionResult`. The migrated handler will dispatch to
    transactions / recurring / sources sub-operations.
- **View**
  - `finances` — `FinancesView` at `/finances` with three sections:
    balance summary, transactions, recurring charges. Bundle:
    `dist/views/bundle.js`.
- **Schema** — `pgSchema("app_finances")` with two tables:
  - `transactions` — `(agentId, entityId, occurredAt, amountMinor, currency,
    description, category, merchant, status, source, metadata, …)`
  - `recurring_charges` — `(agentId, entityId, label, amountMinor, currency,
    cadence, nextChargeAt, merchant, active, metadata, …)`

## Migration map from `@elizaos/plugin-lifeops`

| Symbol / file | Source in plugin-lifeops | Destination in plugin-finances |
|---|---|---|
| `ownerFinancesAction` | `src/actions/owner-surfaces.ts` (around line 433) | `src/actions/finances.ts` (`ownerFinancesAction`) |
| `OWNER_FINANCE_ACTIONS`, `OWNER_FINANCE_SIMILES` | `src/actions/owner-surfaces.ts` | `src/actions/finances.ts` (TODO) |
| `MONEY_PARAMETERS`, `runMoneyHandler` | `src/actions/money.ts` | `src/actions/finances.ts` (TODO) |
| Recurring-charge helpers | `src/actions/payments.ts`, `src/actions/lib/payments-recurring.ts` (if present) | `src/actions/finances.ts` / future `src/lib/` (TODO) |
| Finance dashboard view | (currently rendered through `LifeOpsPageView`) | `src/components/finances/FinancesView.tsx` |
| Finance DB tables | (lifeops `src/lifeops/schema.ts` finance sections) | `src/db/schema.ts` (`pgSchema("app_finances")`) |

When the OWNER_FINANCES code is moved over here, delete the corresponding
exports from `plugin-lifeops/src/actions/owner-surfaces.ts` and update the
`promoteSubactionsToActions` wiring in `plugin-lifeops/src/plugin.ts`.

## Commands

```bash
bun run --cwd plugins/plugin-finances typecheck
bun run --cwd plugins/plugin-finances lint
bun run --cwd plugins/plugin-finances test
bun run --cwd plugins/plugin-finances build
bun run --cwd plugins/plugin-finances build:js
bun run --cwd plugins/plugin-finances build:views
bun run --cwd plugins/plugin-finances build:types
bun run --cwd plugins/plugin-finances clean
```

## Conventions

- ESM only (`"type": "module"`).
- Drizzle schema is registered through the `schema` field on the Plugin
  object; the elizaOS runtime owns migrations. No manual migration runner
  here.
- Requires `@elizaos/plugin-sql` to be loaded first (peer dep + declared in
  the plugin `dependencies` array).
