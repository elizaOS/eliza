/**
 * Approval requests — deny.
 *
 * POST /api/v1/approval-requests/:id/deny   (public — signer-facing)
 *
 * The signer chooses to reject the approval. No signature is required; this
 * transition exists so the challenger's `await_approval` can resolve to a
 * denied terminal state instead of timing out.
 */

import { Hono } from "hono";
import { z } from "zod";
import { approvalRequestsRepository } from "@/db/repositories/approval-requests";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { approvalCallbackBus } from "@/lib/services/approval-callback-bus";
import {
  type ApprovalRequestsService,
  createApprovalRequestsService,
} from "@/lib/services/approval-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const DenySchema = z.object({
  reason: z.string().max(500).optional(),
});

let singleton: ApprovalRequestsService | null = null;
function getApprovalRequestsService(): ApprovalRequestsService {
  singleton ??= createApprovalRequestsService({ repository: approvalRequestsRepository });
  return singleton;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing approval request id" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = DenySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }

    const service = getApprovalRequestsService();
    const approvalRequest = await service.markDenied(id, parsed.data.reason);

    await approvalCallbackBus.publish({
      name: "ApprovalDenied",
      approvalRequestId: id,
      reason: parsed.data.reason,
      deniedAt: new Date(),
    });

    return c.json({ success: true, approvalRequest });
  } catch (error) {
    logger.error("[ApprovalRequests API] Failed to deny approval request", { error });
    return failureResponse(c, error);
  }
});

export default app;
