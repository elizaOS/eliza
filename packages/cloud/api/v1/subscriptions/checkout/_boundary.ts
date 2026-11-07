/** Maps checkout conflicts and provider uncertainty to safe, actionable responses. */
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";

/** Reasons a retry of the same request can never succeed; the client must refresh billing. */
const NON_RETRYABLE_REASONS = new Set([
  "checkout_account_mismatch",
  "checkout_organization_fenced",
  "checkout_replay_mismatch",
  "previous_checkout_completed",
]);

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
