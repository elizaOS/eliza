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
  financesSchema,
  type RecurringChargeInsert,
  type RecurringChargeRow,
  recurringChargesTable,
  type TransactionInsert,
  type TransactionRow,
  transactionsTable,
} from "./db/schema.ts";
export { default, financesPlugin } from "./plugin.ts";
export * from "./types.ts";
