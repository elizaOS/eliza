/**
 * OWNER_FINANCES payments back-end for `@elizaos/plugin-finances`.
 *
 * Owns the payment-source / transaction / spending-summary / recurring-charge
 * subactions and their parameter schema. The registered `OWNER_FINANCES`
 * umbrella action lives in `@elizaos/plugin-personal-assistant` because it also
 * dispatches the `subscription_*` verbs to the subscription back-end (which
 * orchestrates the agent's Gmail + browser-bridge surfaces). PA imports
 * {@link runPaymentsHandler} + the parameter constants from here, so the
 * payments logic has a single home.
 */

import type {
  ActionResult,
  AgentContext,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  decodeChildcareWorkScenarioInput,
  evaluateChildcareWorkScenario,
} from "../childcare-work-scenario.ts";
import {
  buildCapabilityMeta,
  buildWriteReceipt,
  computeBudgetStatus,
  computeSourceBalances,
  countDistinctSources,
  detectAnomalies,
  normalizeSubscriptions,
} from "../finance-capabilities.ts";
import { FinancesServiceError } from "../finance-normalize.ts";
import {
  FinancesService,
  type FinancesServiceOptions,
} from "../finances-service.ts";
import type {
  AddPaymentSourceRequest,
  LifeOpsPaymentSourceKind,
} from "../payment-types.ts";

/** Public similes for the OWNER_FINANCES umbrella. */
export const OWNER_FINANCE_SIMILES: readonly string[] = [
  "MONEY",
  "PAYMENTS",
  "SUBSCRIPTIONS",
  "SPENDING",
  "ROCKET_MONEY",
  "BANK_TRANSACTIONS",
  "RECURRING_CHARGES",
  "BUDGET",
  "EXPENSES",
  "CANCEL_SUBSCRIPTION",
  "AUDIT_SUBSCRIPTIONS",
  "CANCEL_NETFLIX",
  "CANCEL_HULU",
  "MANAGE_SUBSCRIPTIONS",
  "CHILDCARE_COST",
  "CHILDCARE_WORK_SCENARIO",
  "RETURN_TO_WORK",
];

/**
 * Parameter schema for the OWNER_FINANCES back-end — the registered umbrella
 * surfaces this as its public param list (after renaming `subaction` →
 * `action`).
 */
export const MONEY_PARAMETERS: readonly {
  name: string;
  description: string;
  required: boolean;
  schema: { type: "string" | "number" | "boolean" };
}[] = [
  {
    name: "subaction",
    description:
      "dashboard | list_sources | add_source | remove_source | import_csv | list_transactions | spending_summary | recurring_charges " +
      "| balances | budget_status | subscriptions | anomalies " +
      "| childcare_work_scenario | subscription_audit | subscription_cancel | subscription_status. Defaults to dashboard for ambiguous intents.",
    required: false,
    schema: { type: "string" },
  },
  // Payments-side params.
  {
    name: "sourceId",
    description: "Payment source UUID for scoped reads and CSV import.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "kind",
    description: "add_source kind: csv | plaid | manual | paypal.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "label",
    description: "Human label when adding a source.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "institution",
    description: "Institution display name.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "accountMask",
    description: "Last-four or mask string.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "csvText",
    description: "Raw CSV payload for import_csv.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "dateColumn",
    description: "CSV column hint for posting date.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "amountColumn",
    description: "CSV column hint for amount.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "merchantColumn",
    description: "CSV column hint for merchant.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "descriptionColumn",
    description: "CSV column hint for description.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "categoryColumn",
    description: "CSV column hint for category.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "windowDays",
    description: "Rolling window for dashboard or spending summaries.",
    required: false,
    schema: { type: "number" },
  },
  {
    name: "sinceDays",
    description: "History window for recurring charge detection.",
    required: false,
    schema: { type: "number" },
  },
  {
    name: "limit",
    description: "Transaction row cap for listings.",
    required: false,
    schema: { type: "number" },
  },
  {
    name: "merchantContains",
    description: "Filter transactions by merchant substring.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "onlyDebits",
    description: "Exclude credits when listing transactions.",
    required: false,
    schema: { type: "boolean" },
  },
  {
    name: "budgetUsd",
    description:
      "For budget_status: the user-supplied budget in USD to compare spend against.",
    required: false,
    schema: { type: "number" },
  },
  {
    name: "scenarioJson",
    description:
      "For childcare_work_scenario: JSON using childcare-work-scenario.v1. Every material category must be known, explicitly not_applicable, or missing; missing values never become zero.",
    required: false,
    schema: { type: "string" },
  },
  // Subscription-side params.
  {
    name: "serviceName",
    description: "Display name of the subscription service.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "serviceSlug",
    description: "Normalized slug for routing.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "candidateId",
    description: "Internal audit candidate identifier.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "cancellationId",
    description: "Ongoing cancellation id for status lookups.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "executor",
    description:
      "Browser executor: user_browser | agent_browser | desktop_native.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "queryWindowDays",
    description: "Days of history for audit queries.",
    required: false,
    schema: { type: "number" },
  },
  {
    name: "confirmed",
    description: "User confirmed cancellation prerequisites.",
    required: false,
    schema: { type: "boolean" },
  },
];

export const MONEY_TAGS: readonly string[] = [
  "domain:finance",
  "capability:read",
  "capability:write",
  "capability:update",
  "capability:delete",
  "capability:execute",
  "surface:remote-api",
  "surface:internal",
  "risk:financial",
  "cost:expensive",
];

export const MONEY_CONTEXTS = [
  "payments",
  "finance",
  "wallet",
  "crypto",
  "subscriptions",
  "browser",
  "automation",
] satisfies readonly AgentContext[];

type PaymentsSubaction =
  | "dashboard"
  | "list_sources"
  | "add_source"
  | "remove_source"
  | "import_csv"
  | "list_transactions"
  | "spending_summary"
  | "recurring_charges"
  | "balances"
  | "budget_status"
  | "subscriptions"
  | "anomalies"
  | "childcare_work_scenario";

type PaymentsActionParams = {
  subaction?: PaymentsSubaction;
  sourceId?: string;
  kind?: LifeOpsPaymentSourceKind;
  label?: string;
  institution?: string | null;
  accountMask?: string | null;
  csvText?: string;
  dateColumn?: string;
  amountColumn?: string;
  merchantColumn?: string;
  descriptionColumn?: string;
  categoryColumn?: string;
  windowDays?: number;
  sinceDays?: number;
  limit?: number;
  merchantContains?: string;
  onlyDebits?: boolean;
  budgetUsd?: number;
  scenarioJson?: string;
};

function mergeParams(
  message: Memory,
  options?: HandlerOptions,
): PaymentsActionParams {
  const params = {
    ...(((options as Record<string, unknown> | undefined)?.parameters ??
      {}) as Record<string, unknown>),
  };
  if (message.content && typeof message.content === "object") {
    for (const [key, value] of Object.entries(
      message.content as Record<string, unknown>,
    )) {
      if (params[key] === undefined) {
        params[key] = value;
      }
    }
  }
  return params as PaymentsActionParams;
}

function normalizeSubaction(value: unknown): PaymentsSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/[- ]/g, "_");
  const subactions: PaymentsSubaction[] = [
    "dashboard",
    "list_sources",
    "add_source",
    "remove_source",
    "import_csv",
    "list_transactions",
    "spending_summary",
    "recurring_charges",
    "balances",
    "budget_status",
    "subscriptions",
    "anomalies",
    "childcare_work_scenario",
  ];
  return (subactions as string[]).includes(normalized)
    ? (normalized as PaymentsSubaction)
    : null;
}

/** Evaluates the versioned JSON contract without touching finance storage. */
export function runChildcareWorkScenarioJson(
  scenarioJson: string | undefined,
): ActionResult {
  if (typeof scenarioJson !== "string" || scenarioJson.trim().length === 0) {
    return {
      success: false,
      text: "A childcare/work comparison requires scenarioJson using childcare-work-scenario.v1.",
      data: { error: "MISSING_CHILDCARE_WORK_SCENARIO" },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(scenarioJson);
  } catch {
    // error-policy:J3 The planner/user JSON is an untrusted action boundary;
    // a parse failure remains explicitly invalid and never becomes an empty
    // or zero-valued financial scenario.
    return {
      success: false,
      text: "The childcare/work scenario JSON is invalid; no comparison was calculated.",
      data: { error: "INVALID_CHILDCARE_WORK_SCENARIO_JSON" },
    };
  }
  const scenario = decodeChildcareWorkScenarioInput(parsed);
  const result = evaluateChildcareWorkScenario(scenario);
  return {
    success: result.status === "complete",
    text:
      result.status === "complete"
        ? `Compared ${result.options.length} household childcare/work options as cash-flow and total-economic ranges. This is decision support, not a recommendation about which adult should work.`
        : `The childcare/work comparison is incomplete: ${result.missingAssumptions.length} material assumption${result.missingAssumptions.length === 1 ? "" : "s"} must be supplied. No numeric totals were produced for incomplete options.`,
    data: { scenario: result },
  };
}

async function runPaymentsActionInner(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options?: HandlerOptions,
): Promise<ActionResult> {
  void state;
  const params = mergeParams(message, options);
  const subaction = normalizeSubaction(params.subaction) ?? "dashboard";
  if (subaction === "childcare_work_scenario") {
    return runChildcareWorkScenarioJson(params.scenarioJson);
  }

  const service = new FinancesService(runtime);

  switch (subaction) {
    case "dashboard": {
      const dashboard = await service.getPaymentsDashboard({
        windowDays: params.windowDays ?? null,
      });
      return {
        success: true,
        text: service.summarizePaymentsDashboard(dashboard),
        data: { dashboard },
      };
    }
    case "list_sources": {
      const sources = await service.listPaymentSources();
      return {
        success: true,
        text:
          sources.length === 0
            ? "No payment sources connected."
            : `${sources.length} payment source${sources.length === 1 ? "" : "s"} connected.`,
        data: { sources },
      };
    }
    case "add_source": {
      if (!params.kind || !params.label) {
        return {
          success: false,
          text: "Adding a payment source requires a kind (csv/plaid/manual/paypal) and a label.",
          data: { error: "MISSING_SOURCE_FIELDS" },
        };
      }
      const request: AddPaymentSourceRequest = {
        kind: params.kind,
        label: params.label,
        institution: params.institution ?? null,
        accountMask: params.accountMask ?? null,
      };
      const source = await service.addPaymentSource(request);
      return {
        success: true,
        text: `Added ${source.kind} source "${source.label}".`,
        data: {
          source,
          receipt: buildWriteReceipt({
            capability: "finance.add_source",
            operation: "create",
            entityType: "payment_source",
            entityId: source.id,
            now: new Date(),
          }),
        },
      };
    }
    case "remove_source": {
      if (!params.sourceId) {
        return {
          success: false,
          text: "Removing a payment source requires sourceId.",
          data: { error: "MISSING_SOURCE_ID" },
        };
      }
      await service.deletePaymentSource(params.sourceId);
      return {
        success: true,
        text: "Payment source removed.",
        data: {
          sourceId: params.sourceId,
          receipt: buildWriteReceipt({
            capability: "finance.remove_source",
            operation: "delete",
            entityType: "payment_source",
            entityId: params.sourceId,
            now: new Date(),
          }),
        },
      };
    }
    case "import_csv": {
      if (!params.sourceId || !params.csvText) {
        return {
          success: false,
          text: "CSV import requires sourceId and csvText.",
          data: { error: "MISSING_IMPORT_FIELDS" },
        };
      }
      const result = await service.importTransactionsCsv({
        sourceId: params.sourceId,
        csvText: params.csvText,
        dateColumn: params.dateColumn,
        amountColumn: params.amountColumn,
        merchantColumn: params.merchantColumn,
        descriptionColumn: params.descriptionColumn,
        categoryColumn: params.categoryColumn,
      });
      const summary = `Imported ${result.inserted} transaction${result.inserted === 1 ? "" : "s"} (${result.skipped} already on file, ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}).`;
      const succeeded = result.errors.length === 0 || result.inserted > 0;
      return {
        success: succeeded,
        text: summary,
        data: {
          result,
          // A receipt is only issued when the import actually changed state;
          // an all-duplicate replay (inserted=0) succeeds but mutates nothing.
          ...(result.inserted > 0
            ? {
                receipt: buildWriteReceipt({
                  capability: "finance.import_csv",
                  operation: "import",
                  entityType: "transactions",
                  entityId: params.sourceId,
                  now: new Date(),
                  counts: {
                    inserted: result.inserted,
                    skipped: result.skipped,
                    errors: result.errors.length,
                  },
                }),
              }
            : {}),
        },
      };
    }
    case "list_transactions": {
      const transactions = await service.listTransactions({
        sourceId: params.sourceId ?? null,
        limit: params.limit ?? null,
        merchantContains: params.merchantContains ?? null,
        onlyDebits: params.onlyDebits ?? null,
      });
      return {
        success: true,
        text: `${transactions.length} transaction${transactions.length === 1 ? "" : "s"} returned.`,
        data: { transactions },
      };
    }
    case "spending_summary": {
      const summary = await service.getSpendingSummary({
        windowDays: params.windowDays ?? null,
        sourceId: params.sourceId ?? null,
      });
      return {
        success: true,
        text: `Spent $${summary.totalSpendUsd.toFixed(2)} in the last ${summary.windowDays} days across ${summary.transactionCount} transactions.`,
        data: { summary },
      };
    }
    case "recurring_charges": {
      const charges = await service.getRecurringCharges({
        sourceId: params.sourceId ?? null,
        sinceDays: params.sinceDays ?? null,
      });
      const annualized = charges.reduce(
        (total, charge) => total + charge.annualizedCostUsd,
        0,
      );
      return {
        success: true,
        text: `Detected ${charges.length} recurring charge${charges.length === 1 ? "" : "s"} worth ~$${annualized.toFixed(2)}/yr.`,
        data: { charges },
      };
    }
    case "balances": {
      const now = new Date();
      const [sources, transactions] = await Promise.all([
        service.listPaymentSources(),
        service.listTransactions({ sourceId: params.sourceId ?? null }),
      ]);
      const scoped = params.sourceId
        ? sources.filter((source) => source.id === params.sourceId)
        : sources;
      const balances = computeSourceBalances(scoped, transactions);
      return {
        success: true,
        text:
          balances.length === 0
            ? "No payment sources connected, so no balances can be derived."
            : `Derived ledger balances for ${balances.length} source${balances.length === 1 ? "" : "s"} (net flow of credits minus settled debits, not institution-reported balances).`,
        data: {
          balances,
          meta: buildCapabilityMeta({
            capability: "finance.balances",
            now,
            transactions,
            sourceCount: scoped.length,
            method: "derived_from_transactions",
            notes: [
              "Net flow is derived from the imported/synced transaction ledger; it is not an institution-reported balance.",
              "Pending transactions are excluded from settled figures and reported separately.",
            ],
          }),
        },
      };
    }
    case "budget_status": {
      if (
        typeof params.budgetUsd !== "number" ||
        !Number.isFinite(params.budgetUsd) ||
        params.budgetUsd <= 0
      ) {
        return {
          success: false,
          text: "budget_status requires a positive budgetUsd amount to compare spend against.",
          data: { error: "MISSING_BUDGET_AMOUNT" },
        };
      }
      const now = new Date();
      const windowDays = Math.max(
        1,
        Math.min(
          365,
          typeof params.windowDays === "number" &&
            Number.isFinite(params.windowDays)
            ? Math.trunc(params.windowDays)
            : 30,
        ),
      );
      const transactions = await service.listTransactions({
        sourceId: params.sourceId ?? null,
        sinceAt: new Date(
          now.getTime() - windowDays * 24 * 60 * 60 * 1000,
        ).toISOString(),
      });
      const budget = computeBudgetStatus({
        transactions,
        budgetUsd: params.budgetUsd,
        windowDays,
        now,
      });
      return {
        success: true,
        text: `Spent $${budget.spentUsd.toFixed(2)} of the $${budget.budgetUsd.toFixed(2)} budget over ${budget.windowDays} days (${budget.status.replace(/_/g, " ")}).`,
        data: {
          budget,
          meta: buildCapabilityMeta({
            capability: "finance.budget_status",
            now,
            transactions,
            sourceCount: countDistinctSources(transactions),
            method: "user_supplied_input",
            windowDays,
            notes: [
              "The budget amount is supplied by the user; spend is derived from settled debit transactions in the window.",
            ],
          }),
        },
      };
    }
    case "subscriptions": {
      const now = new Date();
      const charges = await service.getRecurringCharges({
        sourceId: params.sourceId ?? null,
        sinceDays: params.sinceDays ?? null,
      });
      const subscriptions = normalizeSubscriptions(charges);
      const annualized = subscriptions.reduce(
        (total, sub) => total + sub.annualizedCostUsd,
        0,
      );
      // Freshness reflects the transaction rows the recurring-charge
      // aggregates were derived from, not a fabricated empty ledger.
      let latestChargeDataAt: string | null = null;
      let chargeTransactionCount = 0;
      const chargeSourceIds = new Set<string>();
      for (const charge of charges) {
        if (
          latestChargeDataAt === null ||
          charge.latestSeenAt > latestChargeDataAt
        ) {
          latestChargeDataAt = charge.latestSeenAt;
        }
        chargeTransactionCount += charge.occurrenceCount;
        for (const sourceId of charge.sourceIds) {
          chargeSourceIds.add(sourceId);
        }
      }
      return {
        success: true,
        text:
          subscriptions.length === 0
            ? "No subscription-like recurring charges detected."
            : `Detected ${subscriptions.length} likely subscription${subscriptions.length === 1 ? "" : "s"} totaling ~$${annualized.toFixed(2)}/yr.`,
        data: {
          subscriptions,
          meta: buildCapabilityMeta({
            capability: "finance.subscriptions",
            now,
            transactions: [],
            latestDataAt: latestChargeDataAt,
            transactionCount: chargeTransactionCount,
            sourceCount: chargeSourceIds.size,
            method: "derived_from_transactions",
            windowDays: params.sinceDays ?? null,
            notes: [
              "Subscriptions are inferred from regular-cadence recurring debits with detection confidence >= 0.5; this is detection, not billing-provider data.",
            ],
          }),
        },
      };
    }
    case "anomalies": {
      const now = new Date();
      const windowDays = Math.max(
        7,
        Math.min(
          365,
          typeof params.sinceDays === "number" &&
            Number.isFinite(params.sinceDays)
            ? Math.trunc(params.sinceDays)
            : 90,
        ),
      );
      const transactions = await service.listTransactions({
        sourceId: params.sourceId ?? null,
        sinceAt: new Date(
          now.getTime() - windowDays * 24 * 60 * 60 * 1000,
        ).toISOString(),
      });
      const anomalies = detectAnomalies(transactions);
      return {
        success: true,
        text:
          anomalies.length === 0
            ? `No duplicate-charge or amount-spike anomalies detected across ${transactions.length} transactions.`
            : `Flagged ${anomalies.length} possible anomal${anomalies.length === 1 ? "y" : "ies"} (duplicate charges or amount spikes) for review.`,
        data: {
          anomalies,
          meta: buildCapabilityMeta({
            capability: "finance.anomalies",
            now,
            transactions,
            sourceCount: countDistinctSources(transactions),
            method: "derived_from_transactions",
            windowDays,
            notes: [
              "Heuristic detection over settled debits: same-merchant same-amount charges within 3 days, and debits >= 2.5x a merchant's prior average. Flags are candidates for human review, not confirmed errors.",
            ],
          }),
        },
      };
    }
  }
}

/**
 * Handler function backing OWNER_FINANCES payment-source and spending
 * subactions. The umbrella in plugin-personal-assistant's `money.ts` is the
 * only caller; no Action object is registered for this handler here.
 */
export async function runPaymentsHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
): Promise<ActionResult> {
  try {
    return await runPaymentsActionInner(runtime, message, state, options);
  } catch (error) {
    if (error instanceof FinancesServiceError) {
      return {
        success: false,
        text: error.message,
        data: { status: error.status },
      };
    }
    throw error;
  }
}

export type { FinancesServiceOptions };
