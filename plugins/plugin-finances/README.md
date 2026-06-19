# @elizaos/plugin-finances

Owner-facing finance dashboard for elizaOS: balance summary, transactions, and recurring charges.

## Plugin surface

**Back-end**
- `runPaymentsHandler`, `MONEY_PARAMETERS`, `OWNER_FINANCE_SIMILES`, `MONEY_TAGS`, `MONEY_CONTEXTS` (`src/actions/finances.ts`) — the payments OWNER_FINANCES dispatch and parameter schema. `@elizaos/plugin-personal-assistant` imports these; the registered `OWNER_FINANCES` umbrella action stays in PA because it also routes `subscription_*` to PA's subscription back-end.
- `FinancesService` (`src/finances-service.ts`) — payment sources, CSV import, transactions, spending summaries, recurring-charge detection, and email bills. Holds its own runtime + `FinancesRepository`.
- `FinancesRepository` (`src/db/finances-repository.ts`) — raw SQL over `app_finances`.

**View**
- `finances` — `FinancesView` at `/finances` with balance summary, transactions, and recurring charges. Bundle: `dist/views/bundle.js`.

**Schema** — `pgSchema("app_finances")` (`financesDbSchema`) with five tables:
- `lifePaymentSources` (`life_payment_sources`) — payment source records per agent.
- `lifePaymentTransactions` (`life_payment_transactions`) — transactions; amounts stored as `amount_usd` (real), not minor units.
- `lifeSubscriptionAudits` (`life_subscription_audits`) — subscription audit runs.
- `lifeSubscriptionCandidates` (`life_subscription_candidates`) — detected subscription candidates.
- `lifeSubscriptionCancellations` (`life_subscription_cancellations`) — cancellation records.

Table names are preserved verbatim from the original LifeOps tables (`life_payment_*`, `life_subscription_*`) so the non-destructive copy migration (`FinancesMigrationService`) can move existing `app_lifeops` rows across without data loss.

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

## Config / env vars

| Variable | Required | Description |
|---|---|---|
| `ELIZA_TOKEN_ENCRYPTION_KEY` | No | 32-byte (base64/hex) key encrypting Plaid / PayPal tokens at rest. Falls back to a lazily-generated file under `<oauth-dir>/lifeops/payments/.encryption-key` (mode 0600). |
| `ELIZAOS_CLOUD_API_KEY` | No | Eliza Cloud API key for the managed Plaid / PayPal bridges. |
| `ELIZAOS_CLOUD_BASE_URL` | No | Eliza Cloud base URL override for the managed bridges. |

## Conventions

- ESM only (`"type": "module"`).
- Drizzle schema is registered through the `schema` field on the Plugin object; the elizaOS runtime owns migrations. No manual migration runner here.
- Amounts are stored in USD (`amount_usd` real), not minor units.
- Requires `@elizaos/plugin-sql` to be loaded first (peer dep + declared in the plugin `dependencies` array).
- Do NOT import `@elizaos/plugin-personal-assistant` from this package.
