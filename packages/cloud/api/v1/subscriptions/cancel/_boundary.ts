/** Translates cancellation domain failures into sanitized HTTP outcomes without provider details. */
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import type { AppContext } from "@/types/cloud-worker-env";
export function cancellationFailure(c: AppContext, error: unknown): Response {
  const code = error instanceof Error && "code" in error ? error.code : null;
  switch (code) {
    case "SUBSCRIPTION_CANCELLATION_FORBIDDEN":
      return failureResponse(
        c,
        new ApiError(
          403,
          "access_denied",
          "Subscription cancellation is not authorized",
        ),
      );
    case "SUBSCRIPTION_CANCELLATION_NOT_FOUND":
      return failureResponse(
        c,
        new ApiError(
          404,
          "resource_not_found",
          "Subscription cancellation command not found",
        ),
      );
    case "SUBSCRIPTION_CANCELLATION_CONFLICT":
      return failureResponse(
        c,
        new ApiError(
          409,
          "billing_state_conflict",
          "Subscription cancellation state changed; reload current billing state",
        ),
      );
    case "SUBSCRIPTION_CANCELLATION_REOBSERVE":
      return failureResponse(
        c,
        new ApiError(
          503,
          "service_unavailable",
          "Subscription cancellation requires reconciliation",
        ),
      );
    default:
      return failureResponse(c, error);
  }
}
