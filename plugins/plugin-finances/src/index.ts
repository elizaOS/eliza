/**
 * Public entry for @elizaos/plugin-finances.
 *
 * Default export is the runtime Plugin object. Named exports expose the
 * finance back-end (service, repository, action handler + parameter schema),
 * the schema/types, and the React view component so other packages can import
 * them directly — most notably `@elizaos/plugin-personal-assistant`, which
 * registers the OWNER_FINANCES umbrella action + the /api/lifeops/money/*
 * routes and delegates the payments back-end here.
 */

export {
  MONEY_CONTEXTS,
  MONEY_PARAMETERS,
  MONEY_TAGS,
  OWNER_FINANCE_SIMILES,
  runPaymentsHandler,
} from "./actions/finances.ts";
export {
  EMPTY_FINANCES_SNAPSHOT,
  type FinanceBalanceCard,
  type FinanceRecurringCard,
  type FinancesSnapshot,
  FinancesSpatialView,
  type FinancesViewState,
  type FinanceTransactionCard,
} from "./components/finances/FinancesSpatialView.tsx";
export {
  type FinancesFetchers,
  FinancesView,
  type FinancesViewProps as FinancesViewComponentProps,
  formatMinor,
} from "./components/finances/FinancesView.tsx";
export {
  createLifeOpsSubscriptionAudit,
  createLifeOpsSubscriptionCancellation,
  createLifeOpsSubscriptionCandidate,
  FinancesRepository,
} from "./db/finances-repository.ts";
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
export {
  FinancesServiceError,
  financeErrorMessage,
} from "./finance-normalize.ts";
export {
  encryptPaymentMetadataToken,
  FinancesService,
  type FinancesServiceOptions,
  readPaymentMetadataToken,
  sanitizePaymentSourceForClient,
} from "./finances-service.ts";
export * from "./payment-csv-import.ts";
export * from "./payment-recurrence.ts";
export * from "./payment-types.ts";
export { default, financesPlugin } from "./plugin.ts";
export {
  createSubscriptionsBrowserGateway,
  type SubscriptionsBrowserGateway,
} from "./services/browser-bridge-seam.ts";
export {
  createSubscriptionsGmailGateway,
  type SubscriptionsGmailGateway,
} from "./services/gmail-seam.ts";
export { FinancesMigrationService } from "./services/migration.ts";
export {
  SubscriptionsService,
  type SubscriptionsServiceOptions,
} from "./services/subscriptions-service.ts";
export * from "./subscriptions-playbooks.ts";
export * from "./subscriptions-types.ts";
export {
  decryptTokenEnvelope,
  type EncryptedTokenEnvelope,
  encryptTokenPayload,
  isEncryptedTokenEnvelope,
  resolveTokenEncryptionKey,
} from "./token-encryption.ts";
export * from "./types.ts";
