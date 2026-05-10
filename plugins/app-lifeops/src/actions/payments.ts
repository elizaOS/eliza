import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type {
  AddPaymentSourceRequest,
  LifeOpsPaymentSourceKind,
} from "../lifeops/payment-types.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";

type PaymentsSubaction =
  | "dashboard"
  | "list_sources"
  | "add_source"
  | "remove_source"
  | "import_csv"
  | "list_transactions"
  | "spending_summary"
  | "recurring_charges";

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
};

const ACTION_NAME = "PAYMENTS";

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
  ];
  return (subactions as string[]).includes(normalized)
    ? (normalized as PaymentsSubaction)
    : null;
}

async function runPaymentsAction(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options?: HandlerOptions,
): Promise<ActionResult> {
  void state;
  void message;
  const params = mergeParams(message, options);
  const service = new LifeOpsService(runtime);
  const subaction = normalizeSubaction(params.subaction) ?? "dashboard";

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
        data: { source },
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
        data: { sourceId: params.sourceId },
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
      return {
        success: result.errors.length === 0 || result.inserted > 0,
        text: summary,
        data: { result },
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
  }
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
      content: {
        text: "Import this bank CSV into my Chase source.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll parse the CSV, dedupe against existing transactions, and update the source sync time.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "What recurring charges do I have?" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "I'll detect merchants with regular cadence and amount, and summarize the annualized cost.",
        actions: [ACTION_NAME],
      },
    },
  ],
];

export const paymentsAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "SPENDING",
    "ROCKET_MONEY",
    "BANK_TRANSACTIONS",
    "RECURRING_CHARGES",
    "BUDGET",
    "EXPENSES",
  ],
  description:
    "Track payments and recurring charges: list connected payment sources (bank/CSV/Plaid/PayPal), import transactions from CSV, compute spending summaries, and detect recurring charges.",
  descriptionCompressed:
    "payments+spending: dashboard list-sources add-source remove-source import-csv list-transactions spending-summary recurring-charges; bank/CSV/Plaid/PayPal",
  contexts: ["payments", "finance", "wallet", "crypto", "subscriptions"],
  roleGate: { minRole: "OWNER" },

  parameters: [
    {
      name: "subaction",
      description:
        "dashboard | list_sources | add_source | remove_source | import_csv | list_transactions | spending_summary | recurring_charges (defaults dashboard).",
      required: false,
      schema: { type: "string" as const },
    },
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
  ],

  suppressPostActionContinuation: true,
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
  ): Promise<ActionResult> => {
    try {
      return await runPaymentsAction(runtime, message, state, options);
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        return {
          success: false,
          text: error.message,
          data: { status: error.status },
        };
      }
      throw error;
    }
  },
  examples,
};
