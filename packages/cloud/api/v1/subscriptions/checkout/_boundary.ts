/** Maps checkout conflicts and provider uncertainty to safe, actionable responses. */
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import type { AppContext } from "@/types/cloud-worker-env";
export function checkoutFailure(c: AppContext, error: unknown): Response {
  const code = error instanceof Error && "code" in error ? error.code : null;
  if (code === "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT")
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
