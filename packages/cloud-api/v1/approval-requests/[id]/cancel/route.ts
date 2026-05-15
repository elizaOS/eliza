/**
 * Approval requests — cancel.
 *
 * POST /api/v1/approval-requests/:id/cancel  (authed challenger)
 *
 * The originating org (the agent that opened the approval) aborts the request.
 * Unlike `deny`, cancel is initiated by the challenger, not the signer.
 */

import { Hono } from "hono";
import { z } from "zod";
import { approvalRequestsRepository } from "@/db/repositories/approval-requests";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { approvalCallbackBus } from "@/lib/services/approval-callback-bus";
import {
  type ApprovalRequestsService,
  createApprovalRequestsService,
} from "@/lib/services/approval-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

let singleton: ApprovalRequestsService | null = null;
function getApprovalRequestsService(): ApprovalRequestsService {
  singleton ??= createApprovalRequestsService({
    repository: approvalRequestsRepository,
  });
  return singleton;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        { success: false, error: "Missing approval request id" },
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = CancelSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const service = getApprovalRequestsService();
    const approvalRequest = await service.cancel(
      id,
      user.organization_id,
      parsed.data.reason,
    );

    await approvalCallbackBus.publish({
      name: "ApprovalCanceled",
      approvalRequestId: id,
      reason: parsed.data.reason,
      canceledAt: new Date(),
    });

    return c.json({ success: true, approvalRequest });
  } catch (error) {
    logger.error("[ApprovalRequests API] Failed to cancel approval request", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
