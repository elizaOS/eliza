/** Lists pending schedule commands for the current billing manager with explicit caller-requested pagination. */
import { Hono } from "hono";
import { z } from "zod";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCurrentBillingManagerSession } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { listPendingOrganizationSubscriptionCommands } from "@/lib/services/subscription-command-status";
import type { AppEnv } from "@/types/cloud-worker-env";
import { cancellationFailure } from "../cancel/_boundary";

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
const app = new Hono<AppEnv>();
app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await requireCurrentBillingManagerSession(c);
    const params = querySchema.parse(c.req.query());
    const data = await listPendingOrganizationSubscriptionCommands({
      ...params,
      organizationId: user.organization_id,
      actorId: user.id,
    });
    return c.json({ success: true as const, data });
  } catch (error) {
    // error-policy:J1 The read boundary distinguishes invalid cursors and unavailable state without provider details.
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (
      code === "SUBSCRIPTION_COMMAND_CURSOR_INVALID" ||
      code === "SUBSCRIPTION_COMMAND_PAGE_INVALID"
    )
      return failureResponse(
        c,
        new ApiError(
          400,
          "validation_error",
          "Invalid subscription command pagination",
        ),
      );
    if (
      code === "SUBSCRIPTION_COMMAND_STATE_UNAVAILABLE" ||
      code === "PRIMARY_DATABASE_CLOCK_UNAVAILABLE"
    )
      return failureResponse(
        c,
        new ApiError(
          503,
          "service_unavailable",
          "Subscription command status is unavailable",
        ),
      );
    return cancellationFailure(c, error);
  }
});
export default app;
