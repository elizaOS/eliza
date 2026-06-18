/**
 * Public entry for @elizaos/plugin-finances.
 *
 * Default export is the runtime Plugin object. Named exports expose the
 * action, schema/types, and the React view component so other packages can
 * import them directly (e.g. for tests, storybook, or embedding the view).
 */

export { ownerFinancesAction } from "./actions/finances.ts";
export { FinancesView } from "./components/finances/FinancesView.tsx";
export {
  financesDbSchema,
  financesSchema,
  type LifePaymentSourceInsert,
  type LifePaymentSourceRow,
  type LifePaymentTransactionInsert,
  type LifePaymentTransactionRow,
  type LifeSubscriptionAuditInsert,
  type LifeSubscriptionAuditRow,
  type LifeSubscriptionCancellationInsert,
  type LifeSubscriptionCancellationRow,
  type LifeSubscriptionCandidateInsert,
  type LifeSubscriptionCandidateRow,
  lifePaymentSources,
  lifePaymentTransactions,
  lifeSubscriptionAudits,
  lifeSubscriptionCancellations,
  lifeSubscriptionCandidates,
} from "./db/schema.ts";
export { default, financesPlugin } from "./plugin.ts";
export { FinancesMigrationService } from "./services/migration.ts";
export * from "./types.ts";
