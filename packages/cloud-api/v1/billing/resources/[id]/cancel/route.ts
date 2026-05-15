/**
 * POST /api/v1/billing/resources/:id/cancel
 * Stops future billing for a container or managed agent sandbox.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { activeBillingService, type BillableResourceType } from "@/lib/services/active-billing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CancelSchema = z.object({
  resourceType: z.enum(["container", "agent_sandbox"]).optional(),
  mode: z.enum(["stop", "delete"]).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const resourceId = c.req.param("id");
    if (!resourceId) {
      return c.json({ success: false, error: "Resource id required" }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = CancelSchema.safeParse({
      ...body,
      resourceType: body.resourceType ?? c.req.query("resourceType") ?? c.req.query("type"),
    });
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid cancellation request",
          details: parsed.error.format(),
        },
        400,
      );
    }

    const result = await activeBillingService.cancelResource({
      organizationId: user.organization_id,
      resourceId,
      resourceType: parsed.data.resourceType as BillableResourceType | undefined,
      mode: parsed.data.mode,
    });

    return c.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Billable resource not found") {
      return c.json({ success: false, error: message }, 404);
    }
    logger.error("[Billing Cancel API] Error cancelling billable resource", error);
    return failureResponse(c, error);
  }
});

export default app;
