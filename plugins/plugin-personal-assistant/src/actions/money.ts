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

// The OWNER_FINANCES public similes / parameter schema / tags / contexts moved
// to @elizaos/plugin-finances with the payments back-end. Re-exported here so
// owner-surfaces.ts (the registered umbrella) keeps importing them from this
// module.
export {
  MONEY_CONTEXTS,
  MONEY_PARAMETERS,
  MONEY_TAGS,
  OWNER_FINANCE_SIMILES,
} from "@elizaos/plugin-finances/actions/finances";

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
