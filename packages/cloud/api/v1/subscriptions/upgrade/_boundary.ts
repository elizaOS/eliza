/** Sanitizes original upgrade command errors at the authenticated HTTP boundary. */
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";
export function upgradeFailure(c: AppContext, error: unknown): Response {
  const code = error instanceof Error && "code" in error ? error.code : null;
  if (code === "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN")
    return failureResponse(
      c,
      new ApiError(
        403,
        "access_denied",
        "Current organization billing manager required",
      ),
    );
  if (code === "SUBSCRIPTION_UPGRADE_NOT_FOUND")
    return failureResponse(
      c,
      new ApiError(404, "resource_not_found", "Upgrade command not found"),
    );
  if (code === "SUBSCRIPTION_PLAN_CHANGE_CONFLICT")
    return failureResponse(
      c,
      new ApiError(
        409,
        "billing_state_conflict",
        "Upgrade state changed; read the original command or review again",
      ),
    );
  if (
    typeof code === "string" &&
    (code.startsWith("SUBSCRIPTION_UPGRADE_") ||
      code === "PRIMARY_DATABASE_CLOCK_UNAVAILABLE")
  )
    return failureResponse(
      c,
      new ApiError(
        503,
        "service_unavailable",
        "Upgrade command status is unavailable",
      ),
    );
  return failureResponse(c, error);
}
