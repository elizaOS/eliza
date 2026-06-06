/**
 * Public entry for @elizaos/plugin-finances.
 *
 * Default export is the runtime Plugin object. Named exports expose the
 * action, schema/types, and the React view component so other packages can
 * import them directly (e.g. for tests, storybook, or embedding the view).
 */

export { ownerFinancesAction } from "./actions/finances.ts";
export {
  financesSchema,
  recurringChargesTable,
  type RecurringChargeInsert,
  type RecurringChargeRow,
  transactionsTable,
  type TransactionInsert,
  type TransactionRow,
} from "./db/schema.ts";
export { financesPlugin } from "./plugin.ts";
export { default } from "./plugin.ts";
export * from "./types.ts";
export { FinancesView } from "./components/finances/FinancesView.tsx";
