/**
 * Defines the closed funding-policy vocabulary shared by subscription-aware
 * debit and reservation boundaries. A caller must name both the economic
 * operation and its retry-stable logical key; the funding class is derived on
 * the server so allowance can never be selected by caller-controlled prose.
 */

import { ElizaError } from "@elizaos/core";

export const SUBSCRIPTION_FUNDING_CLASSES = ["allowance_eligible", "cash_only"] as const;

export const SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type SubscriptionFundingClass = (typeof SUBSCRIPTION_FUNDING_CLASSES)[number];

/**
 * Closed economic-operation taxonomy. Anything that does not have an explicit
 * product classification uses `unclassified`, whose policy is cash-only.
 */
export const SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION = {
  ai_inference: "allowance_eligible",
  container_compute: "allowance_eligible",
  managed_agent_compute: "allowance_eligible",
  media_generation: "allowance_eligible",
  search: "allowance_eligible",
  storage: "allowance_eligible",
  voice: "allowance_eligible",
  advertising_or_promotion: "cash_only",
  app_or_marketplace: "cash_only",
  domain: "cash_only",
  hardware_or_network_access: "cash_only",
  payout_or_transfer: "cash_only",
  unclassified: "cash_only",
} as const satisfies Record<string, SubscriptionFundingClass>;

export type SubscriptionFundingOperation = keyof typeof SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION;

export type SubscriptionFundingDebitBoundary = {
  [Operation in SubscriptionFundingOperation]: Readonly<{
    relativePath: string;
    operation: Operation;
    fundingClass: (typeof SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION)[Operation];
    expectedSignals: Readonly<Partial<Record<SubscriptionDebitSignal, number>>>;
  }>;
}[SubscriptionFundingOperation];

export type SubscriptionDebitSignal =
  | "credit_service_deduct"
  | "credit_service_reserve"
  | "credit_service_reserve_and_deduct"
  | "credit_transaction_repository_create"
  | "debit_ledger_literal"
  | "organization_repository_deduct"
  | "raw_credit_balance_decrement"
  | "raw_credit_transaction_sql_insert"
  | "raw_credit_transaction_insert";

/**
 * Review-owned inventory of legacy production debit boundaries. Signal counts
 * make additions fail the audit even when they land beside an already reviewed
 * call, while operation classifications record the required migration policy.
 */
export const SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES = [
  {
    relativePath: "api/fal/proxy/route.ts",
    operation: "media_generation",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_reserve: 1 },
  },
  {
    relativePath: "api/mcp/proxy/[mcpId]/route.ts",
    operation: "app_or_marketplace",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_reserve_and_deduct: 1 },
  },
  {
    relativePath: "api/v1/apis/tunnels/tailscale/auth-key/route.ts",
    operation: "hardware_or_network_access",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "api/v1/apps/[id]/domains/buy/route.ts",
    operation: "domain",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "api/v1/apps/[id]/promote/assets/route.ts",
    operation: "advertising_or_promotion",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/db/repositories/agent-billing.ts",
    operation: "managed_agent_compute",
    fundingClass: "allowance_eligible",
    expectedSignals: {
      debit_ledger_literal: 1,
      raw_credit_balance_decrement: 1,
      raw_credit_transaction_insert: 1,
    },
  },
  {
    relativePath: "shared/src/db/repositories/auto-top-up-attempts.ts",
    operation: "unclassified",
    fundingClass: "cash_only",
    expectedSignals: { raw_credit_transaction_insert: 1 },
  },
  {
    relativePath: "shared/src/db/repositories/container-billing.ts",
    operation: "container_compute",
    fundingClass: "allowance_eligible",
    expectedSignals: {
      debit_ledger_literal: 1,
      raw_credit_balance_decrement: 1,
      raw_credit_transaction_insert: 2,
    },
  },
  {
    relativePath: "shared/src/db/repositories/containers.ts",
    operation: "container_compute",
    fundingClass: "allowance_eligible",
    expectedSignals: { debit_ledger_literal: 1, raw_credit_transaction_insert: 1 },
  },
  {
    relativePath: "shared/src/db/repositories/credit-transactions.ts",
    operation: "unclassified",
    fundingClass: "cash_only",
    expectedSignals: { raw_credit_transaction_insert: 1 },
  },
  {
    relativePath: "shared/src/db/repositories/org-storage-mutations.ts",
    operation: "storage",
    fundingClass: "allowance_eligible",
    expectedSignals: {
      raw_credit_balance_decrement: 1,
      raw_credit_transaction_sql_insert: 2,
    },
  },
  {
    relativePath: "shared/src/db/repositories/org-storage-reads.ts",
    operation: "storage",
    fundingClass: "allowance_eligible",
    expectedSignals: {
      raw_credit_balance_decrement: 1,
      raw_credit_transaction_sql_insert: 1,
    },
  },
  {
    relativePath: "shared/src/db/repositories/organizations.ts",
    operation: "unclassified",
    fundingClass: "cash_only",
    expectedSignals: { debit_ledger_literal: 1, raw_credit_transaction_insert: 1 },
  },
  {
    relativePath: "shared/src/lib/api/a2a/skills.ts",
    operation: "ai_inference",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_reserve: 4 },
  },
  {
    relativePath: "shared/src/lib/mcp/helpers.ts",
    operation: "app_or_marketplace",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/advertising/index.ts",
    operation: "advertising_or_promotion",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 4 },
  },
  {
    relativePath: "shared/src/lib/services/agent-budgets.ts",
    operation: "payout_or_transfer",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_reserve: 1 },
  },
  {
    relativePath: "shared/src/lib/services/agent-monetization.ts",
    operation: "app_or_marketplace",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 2 },
  },
  {
    relativePath: "shared/src/lib/services/ai-billing.ts",
    operation: "ai_inference",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_reserve: 2 },
  },
  {
    relativePath: "shared/src/lib/services/app-credits.ts",
    operation: "app_or_marketplace",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_reserve_and_deduct: 3 },
  },
  {
    relativePath: "shared/src/lib/services/app-promotion.ts",
    operation: "advertising_or_promotion",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/credits.ts",
    operation: "unclassified",
    fundingClass: "cash_only",
    expectedSignals: {
      credit_transaction_repository_create: 1,
      raw_credit_balance_decrement: 2,
      raw_credit_transaction_sql_insert: 6,
    },
  },
  {
    relativePath: "shared/src/lib/services/discord-automation/app-automation.ts",
    operation: "advertising_or_promotion",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/domain-renewals.ts",
    operation: "domain",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/google-search.ts",
    operation: "search",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_reserve: 1 },
  },
  {
    relativePath: "shared/src/lib/services/inference-billing-fast-path.ts",
    operation: "ai_inference",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/inference-billing-ledger.ts",
    operation: "ai_inference",
    fundingClass: "allowance_eligible",
    expectedSignals: {
      raw_credit_balance_decrement: 1,
      raw_credit_transaction_sql_insert: 1,
    },
  },
  {
    relativePath: "shared/src/lib/services/influencer-marketplace.ts",
    operation: "app_or_marketplace",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/meeting-billing.ts",
    operation: "voice",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_reserve: 1 },
  },
  {
    relativePath: "shared/src/lib/services/pending-video-settlement.ts",
    operation: "media_generation",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_reserve: 1 },
  },
  {
    relativePath: "shared/src/lib/services/proxy/birdeye-handler.ts",
    operation: "search",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/proxy/dexscreener-handler.ts",
    operation: "search",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/proxy/engine.ts",
    operation: "search",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_reserve: 1 },
  },
  {
    relativePath: "shared/src/lib/services/seo.ts",
    operation: "search",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/social-media/index.ts",
    operation: "advertising_or_promotion",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 2 },
  },
  {
    relativePath: "shared/src/lib/services/subscription-funding.ts",
    operation: "unclassified",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_reserve_and_deduct: 2 },
  },
  {
    relativePath: "shared/src/lib/services/telegram-automation/app-automation.ts",
    operation: "advertising_or_promotion",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 2 },
  },
  {
    relativePath: "shared/src/lib/services/twitter-automation/app-automation.ts",
    operation: "advertising_or_promotion",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/user-mcps.ts",
    operation: "app_or_marketplace",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/services/x/index.ts",
    operation: "advertising_or_promotion",
    fundingClass: "cash_only",
    expectedSignals: { credit_service_reserve_and_deduct: 1 },
  },
  {
    relativePath: "shared/src/lib/utils/agent-billing.ts",
    operation: "managed_agent_compute",
    fundingClass: "allowance_eligible",
    expectedSignals: { credit_service_deduct: 1 },
  },
] as const satisfies readonly SubscriptionFundingDebitBoundary[];

export type SubscriptionFundingPolicy<
  Operation extends SubscriptionFundingOperation = SubscriptionFundingOperation,
> = Readonly<{
  operation: Operation;
  fundingClass: (typeof SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION)[Operation];
  /** Retry-stable identity for one economic operation, not one HTTP attempt. */
  logicalOperationKey: string;
}>;

/**
 * Creates a policy while enforcing the shared durable-key grammar. The key's
 * product prefix and backing provider/request identity remain caller-owned.
 */
export function createSubscriptionFundingPolicy<Operation extends SubscriptionFundingOperation>(
  operation: Operation,
  logicalOperationKey: string,
): SubscriptionFundingPolicy<Operation> {
  if (!SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN.test(logicalOperationKey)) {
    throw new ElizaError("Subscription funding logical operation key is invalid", {
      code: "INVALID_SUBSCRIPTION_FUNDING_OPERATION_KEY",
      context: { operation, keyLength: logicalOperationKey.length },
      severity: "fatal",
    });
  }

  return Object.freeze({
    operation,
    fundingClass: SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[operation],
    logicalOperationKey,
  });
}
