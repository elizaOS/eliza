/**
 * Approval requests — cancel.
 *
 * POST /api/v1/approval-requests/:id/cancel  (authed challenger)
 *
 * The originating org (the agent that opened the approval) aborts the request.
 * Unlike `deny`, cancel is initiated by the challenger, not the signer.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { approvalRequestsRepository } from "@elizaos/cloud-shared/db/repositories/approval-requests";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { approvalCallbackBus } from "@elizaos/cloud-shared/lib/services/approval-callback-bus";
import {
  type ApprovalRequestsService,
  createApprovalRequestsService,
} from "@elizaos/cloud-shared/lib/services/approval-requests";
import { decodeOptionalRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { parseApprovalRequestIdParam } from "../../approval-request-id";

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
    const parsedId = parseApprovalRequestIdParam(c.req.param("id"));
    if (!parsedId.ok) {
      return c.json({ success: false, error: parsedId.error }, 400);
    }
    const { id } = parsedId;

    const decodedBody = await decodeOptionalRequestJson(c.req);
    if (!decodedBody.ok) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const parsed = CancelSchema.safeParse(decodedBody.value);
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
    // error-policy:J1 boundary translation — failureResponse maps typed/unknown errors to structured JSON.
    logger.error("[ApprovalRequests API] Failed to cancel approval request", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
