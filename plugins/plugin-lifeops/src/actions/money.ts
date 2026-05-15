/**
 * OWNER_FINANCES backend handler.
 *
 * Folds payment-source, transaction, spending-summary, recurring-charge, and
 * subscription-audit backends behind a single dispatch function. The
 * OWNER_FINANCES umbrella in `./owner-surfaces.ts` wraps this handler with the
 * canonical `action` discriminator on the registered surface.
 *
 * Subaction enum:
 *   dashboard | list_sources | add_source | remove_source | import_csv |
 *   list_transactions | spending_summary | recurring_charges |
 *   subscription_audit | subscription_cancel | subscription_status
 *
 * Routing: a single discriminator (`subaction`) selects the backend. The
 * `subscription_*` verbs delegate to the subscription backend; everything
 * else delegates to the finance backend.
 */
import type {
  ActionParameter,
  ActionParameters,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { runPaymentsHandler } from "./payments.js";
import { runSubscriptionsHandler } from "./subscriptions.js";

const SUBSCRIPTION_PREFIX = "subscription_";

/**
 * Public similes for the OWNER_FINANCES umbrella.
 */
export const OWNER_FINANCE_SIMILES: readonly string[] = [
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
];

/**
 * Parameter schema for the OWNER_FINANCES backend — the registered umbrella
 * surfaces this as its public param list (after renaming `subaction` →
 * `action`).
 */
export const MONEY_PARAMETERS: readonly ActionParameter[] = [
  {
    name: "subaction",
    description:
      "dashboard | list_sources | add_source | remove_source | import_csv | list_transactions | spending_summary | recurring_charges " +
      "| subscription_audit | subscription_cancel | subscription_status. Defaults to dashboard for ambiguous intents.",
    required: false,
    schema: { type: "string" as const },
  },
  // Payments-side params.
  {
    name: "sourceId",
    description: "Payment source UUID for scoped reads and CSV import.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "kind",
    description: "add_source kind: csv | plaid | manual | paypal.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "label",
    description: "Human label when adding a source.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "institution",
    description: "Institution display name.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "accountMask",
    description: "Last-four or mask string.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "csvText",
    description: "Raw CSV payload for import_csv.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "dateColumn",
    description: "CSV column hint for posting date.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "amountColumn",
    description: "CSV column hint for amount.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "merchantColumn",
    description: "CSV column hint for merchant.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "descriptionColumn",
    description: "CSV column hint for description.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "categoryColumn",
    description: "CSV column hint for category.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "windowDays",
    description: "Rolling window for dashboard or spending summaries.",
    required: false,
    schema: { type: "number" as const },
  },
  {
    name: "sinceDays",
    description: "History window for recurring charge detection.",
    required: false,
    schema: { type: "number" as const },
  },
  {
    name: "limit",
    description: "Transaction row cap for listings.",
    required: false,
    schema: { type: "number" as const },
  },
  {
    name: "merchantContains",
    description: "Filter transactions by merchant substring.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "onlyDebits",
    description: "Exclude credits when listing transactions.",
    required: false,
    schema: { type: "boolean" as const },
  },
  // Subscription-side params.
  {
    name: "serviceName",
    description: "Display name of the subscription service.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "serviceSlug",
    description: "Normalized slug for routing.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "candidateId",
    description: "Internal audit candidate identifier.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "cancellationId",
    description: "Ongoing cancellation id for status lookups.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "executor",
    description:
      "Browser executor: user_browser | agent_browser | desktop_native.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "queryWindowDays",
    description: "Days of history for audit queries.",
    required: false,
    schema: { type: "number" as const },
  },
  {
    name: "confirmed",
    description: "User confirmed cancellation prerequisites.",
    required: false,
    schema: { type: "boolean" as const },
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

export const MONEY_CONTEXTS: readonly string[] = [
  "payments",
  "finance",
  "wallet",
  "crypto",
  "subscriptions",
  "browser",
  "automation",
];

function readPlannerParams(
  options: HandlerOptions | undefined,
): Record<string, unknown> {
  const raw = (options as Record<string, unknown> | undefined)?.parameters;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function rewriteSubactionForBackend(
  options: HandlerOptions | undefined,
  backendSubaction: string,
): HandlerOptions {
  const incoming = (options ?? {}) as HandlerOptions;
  const incomingParams: ActionParameters = (incoming.parameters ??
    {}) as ActionParameters;
  const next: ActionParameters = {
    ...incomingParams,
    subaction: backendSubaction,
  };
  return { ...incoming, parameters: next };
}

/**
 * Handler function backing the OWNER_FINANCES umbrella.
 */
export async function runMoneyHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
): Promise<ActionResult> {
  const params = readPlannerParams(options);
  const subactionRaw = params.subaction;
  const subaction =
    typeof subactionRaw === "string" ? subactionRaw.trim().toLowerCase() : "";

  if (subaction.startsWith(SUBSCRIPTION_PREFIX)) {
    const backendSubaction = subaction.slice(SUBSCRIPTION_PREFIX.length);
    const forwarded = rewriteSubactionForBackend(options, backendSubaction);
    return runSubscriptionsHandler(runtime, message, state, forwarded);
  }

  // Payments-side. If the subaction is missing, the underlying handler
  // defaults to `dashboard`; we still forward the (possibly empty) value to
  // preserve that behavior.
  return runPaymentsHandler(runtime, message, state, options);
}
