/** Read-only original-actor plan-change discovery after client state loss. */
import { requireCurrentBillingManagerSession } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  ForbiddenError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { listPendingOrganizationPlanChangeCommands } from "@elizaos/cloud-shared/lib/services/subscription-command-status";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { ZodError, z } from "zod";

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
    const input = querySchema.parse(c.req.query());
    const data = await listPendingOrganizationPlanChangeCommands({
      ...input,
      organizationId: user.organization_id,
      actorId: user.id,
    });
    const current = await requireCurrentBillingManagerSession(c);
    if (
      current.id !== user.id ||
      current.organization_id !== user.organization_id
    )
      throw ForbiddenError("Organization billing authority changed");
    return c.json({ success: true as const, data });
  } catch (error) {
    // error-policy:J1 Pagination and current authorization are explicit; private persistence details never reach callers.
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
          "Invalid plan-change command pagination",
        ),
      );
    if (code === "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN")
      return failureResponse(
        c,
        ForbiddenError("Current organization billing manager required"),
      );
    if (error instanceof ApiError || error instanceof ZodError)
      return failureResponse(c, error);
    return failureResponse(
      c,
      new ApiError(
        503,
        "service_unavailable",
        "Plan-change command status is unavailable",
      ),
    );
  }
});
export default app;
