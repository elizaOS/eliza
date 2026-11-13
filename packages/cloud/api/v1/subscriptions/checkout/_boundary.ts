/** Maps checkout conflicts and provider uncertainty to safe, actionable responses. */
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { MobileAppAuthProtocolError } from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";

/** Reasons a retry of the same request can never succeed; the client must refresh billing. */
const NON_RETRYABLE_REASONS = new Set([
  "checkout_account_mismatch",
  "checkout_organization_fenced",
  "checkout_replay_mismatch",
  "previous_checkout_completed",
]);

const DIAGNOSTIC_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ApiError",
  "ElizaError",
  "ZodError",
  "DrizzleQueryError",
  "SubscriptionCatalogError",
  "error",
  "DatabaseError",
  "PostgresError",
  "InferencePolicyFenceError",
  "UnmanagedWriteTransactionError",
  "MobileAppAuthProtocolError",
  "StripeAPIError",
  "StripeConnectionError",
  "StripeAuthenticationError",
  "StripePermissionError",
  "StripeRateLimitError",
  "StripeInvalidRequestError",
]);
const DIAGNOSTIC_CODES = new Set([
  "SUBSCRIPTION_CHECKOUT_UNAVAILABLE",
  "SUBSCRIPTION_CHECKOUT_REJECTED",
  "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT",
  "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
  "ORGANIZATION_POLICY_UNAVAILABLE",
  "SUBSCRIPTION_AUTHORITY_CONFLICT",
  "SUBSCRIPTION_AUTHORITY_TENANT_NOT_FOUND",
  "SUBSCRIPTION_ALLOWANCE_CONFLICT",
  "SUBSCRIPTION_ALLOWANCE_NOT_FOUND",
  "SUBSCRIPTION_ENTITLEMENT_CONFLICT",
  "SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND",
  "SUBSCRIPTION_ENTITLEMENT_TENANT_NOT_FOUND",
  "PRIMARY_DATABASE_CLOCK_UNAVAILABLE",
  "SUBSCRIPTION_ORGANIZATION_SOURCE_UNAVAILABLE",
  "SUBSCRIPTION_CANCELLATION_REOBSERVE",
  "SUBSCRIPTION_RENEWAL_AUTHORITY_CONFLICT",
  "SUBSCRIPTION_RENEWAL_DETAILS_CONFLICT",
  "SUBSCRIPTION_SETTLEMENT_DETAILS_CONFLICT",
  "SUBSCRIPTION_CATALOG_REVISION_NOT_FOUND",
  "SUBSCRIPTION_CATALOG_STRIPE_KEY_INVALID",
  "SUBSCRIPTION_CATALOG_DEPLOYMENT_MODE_MISMATCH",
  "SUBSCRIPTION_CATALOG_BINDING_INVALID",

  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
// These names belong to the existing checkout publication schema. Never copy
// arbitrary constraint names, SQL, messages, or provider context into the tail.
const DIAGNOSTIC_CONSTRAINTS = new Set([
  "billing_subscriptions_app_shape",
  "billing_subscription_revisions_app_shape",
  "organization_entitlements_plan_state_check",
  "billing_subscription_commands_status_shape_check",
  "subscription_allowance_periods_invoice_id_check",
  "subscription_allowance_periods_no_overlap",
]);

function diagnosticError(error: unknown) {
  if (!error || typeof error !== "object") return { name: "unknown" };
  const value = error as {
    name?: unknown;
    code?: unknown;
    constraint?: unknown;
  };
  const name =
    typeof value.name === "string" && DIAGNOSTIC_NAMES.has(value.name)
      ? value.name
      : "unknown";
  const code = typeof value.code === "string" ? value.code : "";
  return {
    name,
    ...(DIAGNOSTIC_CODES.has(code) && { code }),
    ...(/^[0-9A-Z]{5}$/.test(code) && { sqlstate: code }),
    ...(typeof value.constraint === "string" &&
      DIAGNOSTIC_CONSTRAINTS.has(value.constraint) && {
        constraint: value.constraint,
      }),
  };
}

function typeErrorLocation(
  error: unknown,
): { line: number; column: number } | undefined {
  if (!(error instanceof TypeError) || typeof error.stack !== "string") return;
  for (const frame of error.stack.split("\n").slice(1)) {
    const match =
      /^\s+at (?:[^()\r\n]+ \()?(?:async )?(?:(?:file:\/\/\/|\/)(?:[^()\s]+\/)*)?(?:worker|index)\.js:([1-9]\d*):([1-9]\d*)\)?$/.exec(
        frame,
      );
    if (!match) continue;
    const line = Number(match[1]);
    const column = Number(match[2]);
    if (Number.isSafeInteger(line) && Number.isSafeInteger(column))
      return { line, column };
  }
}

/** Only finite diagnostic identifiers from the error and its direct driver cause. */
export function checkoutFailureDiagnostic(error: unknown) {
  try {
    const cause =
      error && typeof error === "object" && "cause" in error
        ? error.cause
        : null;
    const location = typeErrorLocation(error);
    return {
      ...diagnosticError(error),
      ...(location ? { location } : {}),
      ...(cause !== null && cause !== undefined
        ? { cause: diagnosticError(cause) }
        : {}),
    };
  } catch {
    return { name: "unknown" };
  }
}

function reasonOf(error: unknown): string | null {
  if (!(error instanceof Error) || !("context" in error)) return null;
  const context = error.context;
  if (!context || typeof context !== "object" || !("reason" in context))
    return null;
  return typeof context.reason === "string" ? context.reason : null;
}

export function checkoutFailure(c: AppContext, error: unknown): Response {
  const code = error instanceof Error && "code" in error ? error.code : null;
  const reason = reasonOf(error);
  if (error instanceof MobileAppAuthProtocolError) {
    // The credential's native client is unknown, disabled or re-registered: the app must
    // sign in again. A broken server registration is a retryable outage, not the caller's fault.
    return failureResponse(
      c,
      error.protocolCode === "invalid_client"
        ? new ApiError(
            401,
            "authentication_required",
            "This app credential can no longer manage billing. Sign in again.",
          )
        : new ApiError(
            503,
            "service_unavailable",
            "Subscription checkout is not available for this app right now.",
          ),
    );
  }
  if (error instanceof ApiError && error.status === 403)
    return failureResponse(
      c,
      new ApiError(
        403,
        "access_denied",
        "Only organization owners and admins can manage subscription billing.",
      ),
    );
  if (
    code === "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT" ||
    code === "SUBSCRIPTION_CHECKOUT_REJECTED" ||
    (reason !== null && NON_RETRYABLE_REASONS.has(reason))
  )
    return failureResponse(
      c,
      new ApiError(
        409,
        "billing_state_conflict",
        "An existing subscription or checkout requires attention. Refresh billing before starting another purchase.",
      ),
    );
  if (
    code === "SUBSCRIPTION_CHECKOUT_UNAVAILABLE" ||
    code === "SUBSCRIPTION_RENEWAL_UNAVAILABLE"
  )
    return failureResponse(
      c,
      new ApiError(
        503,
        "service_unavailable",
        "Subscription checkout is awaiting confirmation. Retry to check the existing purchase.",
      ),
    );
  return failureResponse(c, error);
}
