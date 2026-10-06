/** Sanitizes original downgrade command errors at the authenticated HTTP boundary. */
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { ZodError } from "zod";
export function downgradeFailure(c: AppContext, error: unknown): Response {
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
  if (
    code === "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" ||
    code === "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE"
  )
    return failureResponse(
      c,
      new ApiError(
        409,
        "billing_state_conflict",
        "Downgrade state changed; read the original command or review again",
      ),
    );
  if (
    typeof code === "string" &&
    (code.startsWith("SUBSCRIPTION_DOWNGRADE_") ||
      code.startsWith("SUBSCRIPTION_SCHEDULE_") ||
      code === "PRIMARY_DATABASE_CLOCK_UNAVAILABLE")
  )
    return failureResponse(
      c,
      new ApiError(
        503,
        "service_unavailable",
        "Downgrade command status is unavailable",
      ),
    );
  if (error instanceof ApiError || error instanceof ZodError)
    return failureResponse(c, error);
  // Provider/persistence message heuristics must not turn private payloads into 4xx text.
  return failureResponse(
    c,
    new ApiError(
      503,
      "service_unavailable",
      "Downgrade command status is unavailable",
    ),
  );
}
