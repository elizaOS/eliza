/**
 * Approval requests — single resource (Wave D).
 *
 * GET  /api/v1/approval-requests/:id            Authed creator view (full row).
 * GET  /api/v1/approval-requests/:id?public=1   Redacted public view (no auth):
 *                                               strips signatureText so an
 *                                               unauthenticated signer can read
 *                                               the challenge before signing.
 */

import { Hono } from "hono";
import { approvalRequestsRepository } from "@/db/repositories/approval-requests";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  type ApprovalRequestsService,
  createApprovalRequestsService,
  redactApprovalRequestForPublic,
} from "@/lib/services/approval-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

let singleton: ApprovalRequestsService | null = null;
function getApprovalRequestsService(): ApprovalRequestsService {
  singleton ??= createApprovalRequestsService({
    repository: approvalRequestsRepository,
  });
  return singleton;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        { success: false, error: "Missing approval request id" },
        400,
      );
    }

    const isPublic = c.req.query("public") === "1";
    const service = getApprovalRequestsService();

    if (isPublic) {
      const row = await service.getPublic(id);
      if (!row) {
        return c.json(
          { success: false, error: "Approval request not found" },
          404,
        );
      }
      return c.json({
        success: true,
        approvalRequest: redactApprovalRequestForPublic(row),
      });
    }

    const user = await requireUserOrApiKeyWithOrg(c);
    const row = await service.get(id, user.organization_id);
    if (!row) {
      return c.json(
        { success: false, error: "Approval request not found" },
        404,
      );
    }

    return c.json({ success: true, approvalRequest: row });
  } catch (error) {
    logger.error("[ApprovalRequests API] Failed to get approval request", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
