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
import {
  activeBillingService,
  type BillableResourceType,
} from "@/lib/services/active-billing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const LegacyCancelSchema = z.object({
  resourceType: z.enum(["container", "agent_sandbox"]).optional(),
  mode: z.enum(["stop", "delete"]).optional(),
});

const DurableCancelSchema = z.object({
  resourceType: z.enum(["container", "agent_sandbox"]),
  mode: z.literal("stop").default("stop"),
  expectedLifecycleRevision: z.number().int().nonnegative().safe(),
});

const DURABLE_CANCEL_VERSION_HEADER = "X-Eliza-Billing-Cancel-Version";

const app = new Hono<AppEnv>();

app.use("*", moneyRateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const resourceId = c.req.param("id");
    if (!resourceId) {
      return c.json({ success: false, error: "Resource id required" }, 400);
    }
    const contractVersion = c.req.header(DURABLE_CANCEL_VERSION_HEADER)?.trim();
    if (contractVersion && contractVersion !== "2") {
      return c.json(
        { success: false, error: "Unsupported billing cancellation version" },
        400,
      );
    }
    const durableRequest = contractVersion === "2";

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const candidate = {
      ...body,
      resourceType:
        body.resourceType ?? c.req.query("resourceType") ?? c.req.query("type"),
    };
    const parsed = durableRequest
      ? DurableCancelSchema.safeParse(candidate)
      : LegacyCancelSchema.safeParse(candidate);
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
    if (!durableRequest) {
      const legacy = parsed.data as z.infer<typeof LegacyCancelSchema>;
      const result = await activeBillingService.cancelResource({
        organizationId: user.organization_id,
        resourceId,
        resourceType: legacy.resourceType as BillableResourceType | undefined,
        mode: legacy.mode,
        triggerEnv: c.env,
        authorizeInfrastructureMutation: async () => {
          await requireCurrentBillingManagerSession(c);
        },
      });
      c.header("Deprecation", "true");
      c.header(
        "Link",
        '</api/v1/billing/resources/{id}/cancel>; rel="successor-version"',
      );
      return c.json({ success: true, ...result });
    }
    if (!z.uuid().safeParse(resourceId).success) {
      return c.json(
        { success: false, error: "Resource id must be a UUID" },
        400,
      );
    }
    const durable = parsed.data as z.infer<typeof DurableCancelSchema>;
    const result = await activeBillingService.requestCancellation({
      organizationId: user.organization_id,
      requestedByUserId: user.id,
      resourceId,
      resourceType: durable.resourceType,
      expectedLifecycleRevision: durable.expectedLifecycleRevision,
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
          : result.receipt.status === "terminal_attention"
            ? 424
            : 200;
    c.header(DURABLE_CANCEL_VERSION_HEADER, "2");
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
