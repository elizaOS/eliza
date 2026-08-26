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

const LegacyCancelSchema = z.object({
  resourceType: z.enum(["container", "agent_sandbox"]).optional(),
  mode: z.enum(["stop", "delete"]).default("stop"),
  expectedLifecycleRevision: z.number().int().nonnegative().safe().optional(),
});

const DurableCancelSchema = z.object({
  resourceType: z.enum(["container", "agent_sandbox"]),
  mode: z.literal("stop").default("stop"),
  expectedLifecycleRevision: z.number().int().nonnegative().safe(),
});

const DURABLE_CANCEL_VERSION_HEADER = "X-Eliza-Billing-Cancel-Version";

function querySafeInteger(
  value: string | undefined,
): number | string | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) return value;
  return Number(value);
}

function compatibilityIdempotencyKey(
  resourceType: "container" | "agent_sandbox",
  resourceId: string,
  expectedLifecycleRevision: number,
): string {
  return `billing-cancel-compat:${resourceType}:${resourceId.toLowerCase()}:${expectedLifecycleRevision}`;
}

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
    const contractVersion = c.req.header(DURABLE_CANCEL_VERSION_HEADER)?.trim();
    if (contractVersion && contractVersion !== "2") {
      return c.json(
        { success: false, error: "Unsupported billing cancellation version" },
        400,
      );
    }
    const durableRequest = contractVersion === "2";

    const rawBody = await c.req.text();
    let body: Record<string, unknown> = {};
    if (rawBody !== "") {
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawBody);
      } catch {
        // error-policy:J3 untrusted-input sanitizing — invalid JSON becomes an
        // explicit 400 response and never reaches cancellation admission.
        return c.json(
          { success: false, error: "Cancellation body must be valid JSON" },
          400,
        );
      }
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        Array.isArray(decoded)
      ) {
        return c.json(
          { success: false, error: "Cancellation body must be a JSON object" },
          400,
        );
      }
      body = decoded as Record<string, unknown>;
    }
    const candidate = durableRequest
      ? {
          ...body,
          // Preserve the published v2 resource-type query alias, but never
          // allow legacy query fields to complete an otherwise invalid v2
          // JSON contract.
          resourceType:
            body.resourceType ??
            c.req.query("resourceType") ??
            c.req.query("type"),
        }
      : {
          ...body,
          resourceType:
            body.resourceType ??
            c.req.query("resourceType") ??
            c.req.query("type"),
          mode: body.mode ?? c.req.query("mode"),
          expectedLifecycleRevision:
            body.expectedLifecycleRevision ??
            querySafeInteger(c.req.query("expectedLifecycleRevision")),
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
    const cancellation = parsed.data as
      | z.infer<typeof LegacyCancelSchema>
      | z.infer<typeof DurableCancelSchema>;
    const needsTargetResolution =
      cancellation.resourceType === undefined ||
      cancellation.expectedLifecycleRevision === undefined;
    const resolved = needsTargetResolution
      ? await activeBillingService.resolveCancellationTarget(
          user.organization_id,
          resourceId,
          cancellation.resourceType,
        )
      : null;
    const resourceType = cancellation.resourceType ?? resolved!.resourceType;
    const expectedLifecycleRevision =
      cancellation.expectedLifecycleRevision ?? resolved!.lifecycleRevision;
    const explicitIdempotencyKey =
      c.req.header("Idempotency-Key")?.trim() ?? "";
    const compatibilityReasons = durableRequest
      ? []
      : [
          cancellation.resourceType === undefined ? "resourceType" : null,
          cancellation.expectedLifecycleRevision === undefined
            ? "expectedLifecycleRevision"
            : null,
          explicitIdempotencyKey === "" ? "Idempotency-Key" : null,
          cancellation.mode === "delete" ? "mode=delete" : null,
        ].filter((reason): reason is string => reason !== null);
    const result = await activeBillingService.requestCancellation({
      organizationId: user.organization_id,
      requestedByUserId: user.id,
      resourceId,
      resourceType,
      expectedLifecycleRevision,
      idempotencyKey: durableRequest
        ? explicitIdempotencyKey
        : explicitIdempotencyKey ||
          compatibilityIdempotencyKey(
            resourceType,
            resourceId,
            expectedLifecycleRevision,
          ),
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
    if (!durableRequest) {
      c.header("Deprecation", "true");
      c.header(
        "Link",
        '</api/v1/billing/resources/{id}/cancel>; rel="successor-version"',
      );
    }
    if (compatibilityReasons.length > 0) {
      c.header(
        "Warning",
        '299 elizaOS "Legacy billing cancellation request normalized; send resourceType, expectedLifecycleRevision, Idempotency-Key, and mode=stop"',
      );
    }
    return c.json(
      {
        success: !["conflict", "terminal_attention"].includes(
          result.receipt.status,
        ),
        ...result,
        ...(compatibilityReasons.length > 0
          ? {
              compatibility: {
                normalized: true,
                reasons: compatibilityReasons,
                effectiveRequest: {
                  resourceType,
                  mode: "stop" as const,
                  expectedLifecycleRevision,
                },
                ...(cancellation.mode === "delete"
                  ? {
                      requestedMode: "delete" as const,
                      deletionPerformed: false,
                      message:
                        "Legacy mode=delete is deprecated and was normalized to a durable stop; use the dedicated resource DELETE endpoint for deletion.",
                    }
                  : {}),
              },
            }
          : {}),
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
