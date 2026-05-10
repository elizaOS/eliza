/**
 * MONEY umbrella — Audit B Defer #4.
 *
 * Folds the previous standalone `PAYMENTS` (8 subactions) and `SUBSCRIPTIONS`
 * (3 subactions) actions into a single umbrella. Subactions stay flat — the
 * union shape gives the planner one umbrella with 11 unambiguous verbs.
 *
 * Subaction enum (PAYMENTS verbs first, then `subscription_*` to disambiguate
 * from any future PAYMENTS verb that might collide):
 *   dashboard | list_sources | add_source | remove_source | import_csv |
 *   list_transactions | spending_summary | recurring_charges |
 *   subscription_audit | subscription_cancel | subscription_status
 *
 * Routing: a single discriminator (`subaction`) selects the backend service.
 * The `subscription_*` verbs delegate to the SUBSCRIPTIONS backend; everything
 * else delegates to the PAYMENTS backend.
 */
import type {
  Action,
  ActionExample,
  ActionParameters,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { paymentsActionImpl } from "./payments.js";
import { subscriptionsActionImpl } from "./subscriptions.js";

const ACTION_NAME = "MONEY";

type MoneyPaymentsSubaction =
  | "dashboard"
  | "list_sources"
  | "add_source"
  | "remove_source"
  | "import_csv"
  | "list_transactions"
  | "spending_summary"
  | "recurring_charges";

type MoneySubscriptionSubaction =
  | "subscription_audit"
  | "subscription_cancel"
  | "subscription_status";

type MoneySubaction = MoneyPaymentsSubaction | MoneySubscriptionSubaction;

const ALL_SUBACTIONS: readonly MoneySubaction[] = [
  "dashboard",
  "list_sources",
  "add_source",
  "remove_source",
  "import_csv",
  "list_transactions",
  "spending_summary",
  "recurring_charges",
  "subscription_audit",
  "subscription_cancel",
  "subscription_status",
];

const SUBSCRIPTION_PREFIX = "subscription_";

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

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "How much am I spending on subscriptions?" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll pull your payments dashboard with monthly spend, recurring charges, and categories.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Audit my subscriptions and tell me what I can cancel." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll audit recent subscription signals and summarize what looks active, already canceled, or worth reviewing.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Cancel my Netflix subscription." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll open the subscription flow for Netflix, pause for confirmation if needed, and then report the result.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Import this bank CSV into my Chase source." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll parse the CSV, dedupe against existing transactions, and update the source sync time.",
        actions: [ACTION_NAME],
      },
    },
  ],
];

export const moneyAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    // Legacy umbrella names — keep so cached planner outputs and the
    // `lifeops` provider's route hints keep resolving.
    "PAYMENTS",
    "SUBSCRIPTIONS",
    // Legacy similes from the two folded actions.
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
  ],
  tags: [
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
  ],
  description:
    "Track payments and subscriptions. " +
    "Subactions: dashboard, list_sources, add_source, remove_source, import_csv, list_transactions, spending_summary, recurring_charges, subscription_audit, subscription_cancel, subscription_status. " +
    "Subscription cancellations route through the browser executor; payment data comes from bank, CSV, Plaid, or PayPal.",
  descriptionCompressed:
    "payments+subscriptions: dashboard|list_sources|add_source|remove_source|import_csv|list_transactions|spending_summary|recurring_charges|subscription_audit|subscription_cancel|subscription_status",
  contexts: [
    "payments",
    "finance",
    "wallet",
    "crypto",
    "subscriptions",
    "browser",
    "automation",
  ],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async () => true,

  parameters: [
    {
      name: "subaction",
      description:
        "dashboard | list_sources | add_source | remove_source | import_csv | list_transactions | spending_summary | recurring_charges " +
        "| subscription_audit | subscription_cancel | subscription_status. Defaults to dashboard for ambiguous intents.",
      required: true,
      schema: { type: "string" as const, enum: [...ALL_SUBACTIONS] },
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
  ],

  examples,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: HandlerOptions | undefined,
  ): Promise<ActionResult> => {
    const params = readPlannerParams(options);
    const subactionRaw = params.subaction;
    const subaction =
      typeof subactionRaw === "string" ? subactionRaw.trim().toLowerCase() : "";

    if (subaction.startsWith(SUBSCRIPTION_PREFIX)) {
      const backendSubaction = subaction.slice(SUBSCRIPTION_PREFIX.length);
      const forwarded = rewriteSubactionForBackend(options, backendSubaction);
      return subscriptionsActionImpl.handler(runtime, message, state, forwarded);
    }

    // Payments-side. If the subaction is missing, the underlying handler
    // defaults to `dashboard`; we still forward the (possibly empty) value to
    // preserve that behavior.
    return paymentsActionImpl.handler(runtime, message, state, options);
  },
};
