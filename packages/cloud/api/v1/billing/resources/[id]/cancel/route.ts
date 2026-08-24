/**
 * POST /api/v1/billing/resources/:id/cancel
 * Durably admits a provider stop for a container or managed agent sandbox.
 * Billing is reported stopped only after provider confirmation is persisted.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCurrentBillingManagerSession } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { activeBillingService } from "@/lib/services/active-billing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CancelSchema = z.object({
  resourceType: z.enum(["container", "agent_sandbox"]),
  mode: z.literal("stop").default("stop"),
  expectedLifecycleRevision: z.number().int().nonnegative().safe(),
});

const app = new Hono<AppEnv>();

app.use("*", moneyRateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const resourceId = c.req.param("id");
    if (!resourceId) {
      return c.json({ success: false, error: "Resource id required" }, 400);
    }
    if (!z.uuid().safeParse(resourceId).success) {
      return c.json(
        { success: false, error: "Resource id must be a UUID" },
        400,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const parsed = CancelSchema.safeParse({
      ...body,
      resourceType:
        body.resourceType ?? c.req.query("resourceType") ?? c.req.query("type"),
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

    const user = await requireCurrentBillingManagerSession(c);
    const result = await activeBillingService.requestCancellation({
      organizationId: user.organization_id,
      requestedByUserId: user.id,
      resourceId,
      resourceType: parsed.data.resourceType,
      expectedLifecycleRevision: parsed.data.expectedLifecycleRevision,
      idempotencyKey: c.req.header("Idempotency-Key")?.trim() ?? "",
      triggerEnv: c.env,
      authorizeInfrastructureMutation: async () => {
        const current = await requireCurrentBillingManagerSession(c);
        return current.steward_id;
      },
    });

    const status =
      result.receipt.status === "accepted"
        ? 202
        : result.receipt.status === "conflict"
          ? 409
          : 200;
    return c.json(
      {
        success: !["conflict", "terminal_attention"].includes(
          result.receipt.status,
        ),
        ...result,
      },
      status,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Billable resource not found") {
      return c.json({ success: false, error: message }, 404);
    }
    logger.error(
      "[Billing Cancel API] Error cancelling billable resource",
      error,
    );
    return failureResponse(c, error);
  }
});

export default app;
