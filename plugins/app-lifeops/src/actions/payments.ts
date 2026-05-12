import type {
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

async function runPaymentsActionInner(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options?: HandlerOptions,
): Promise<ActionResult> {
  void state;
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

/**
 * Handler function backing OWNER_FINANCES payment-source and spending
 * subactions. The umbrella in `./money.ts` is the only caller; no Action object
 * is registered for this handler.
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
    if (error instanceof LifeOpsServiceError) {
      return {
        success: false,
        text: error.message,
        data: { status: error.status },
      };
    }
    throw error;
  }
}
