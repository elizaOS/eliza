/**
 * Approval requests — approve.
 *
 * POST /api/v1/approval-requests/:id/approve   (public — signer-facing)
 *
 * The signer is by definition unauthenticated at this point; the proof of
 * identity comes from the signature in the body, verified by the
 * IdentityVerificationGatekeeper.
 */

import { Hono } from "hono";
import { z } from "zod";
import { approvalRequestsRepository } from "@/db/repositories/approval-requests";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { approvalCallbackBus } from "@/lib/services/approval-callback-bus";
import {
  type ApprovalRequestsService,
  createApprovalRequestsService,
} from "@/lib/services/approval-requests";
import {
  createIdentityVerificationGatekeeper,
  type IdentityVerificationGatekeeper,
} from "@/lib/services/identity-verification-gatekeeper";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ApproveSchema = z.object({
  signature: z.string().min(1).max(4096),
  expectedSignerIdentityId: z.string().min(1).max(256).optional(),
});

let serviceSingleton: ApprovalRequestsService | null = null;
let gatekeeperSingleton: IdentityVerificationGatekeeper | null = null;
function getService(): {
  service: ApprovalRequestsService;
  gatekeeper: IdentityVerificationGatekeeper;
} {
  serviceSingleton ??= createApprovalRequestsService({
    repository: approvalRequestsRepository,
  });
  gatekeeperSingleton ??= createIdentityVerificationGatekeeper({
    approvalRequests: serviceSingleton,
  });
  return { service: serviceSingleton, gatekeeper: gatekeeperSingleton };
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        { success: false, error: "Missing approval request id" },
        400,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = ApproveSchema.safeParse(body);
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

    const { service, gatekeeper } = getService();
    const verification = await gatekeeper.verify({
      approvalId: id,
      signature: parsed.data.signature,
      expectedSignerIdentityId: parsed.data.expectedSignerIdentityId,
    });
    if (!verification.valid || !verification.signerIdentityId) {
      return c.json(
        {
          success: false,
          error: verification.error ?? "signature verification failed",
        },
        400,
      );
    }

    const approvalRequest = await service.markApproved({
      approvalRequestId: id,
      signatureText: parsed.data.signature,
      signerIdentityId: verification.signerIdentityId,
    });

    await approvalCallbackBus.publish({
      name: "ApprovalApproved",
      approvalRequestId: id,
      signerIdentityId: verification.signerIdentityId,
      signatureText: parsed.data.signature,
      approvedAt: approvalRequest.signedAt ?? new Date(),
    });

    return c.json({
      success: true,
      approvalRequest,
      signerIdentityId: verification.signerIdentityId,
    });
  } catch (error) {
    logger.error("[ApprovalRequests API] Failed to approve approval request", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
