/**
 * Approval requests — deny.
 *
 * POST /api/v1/approval-requests/:id/deny   (public — signer-facing)
 *
 * The signer chooses to reject the approval. Like /approve, this is a
 * signer-driven state transition on a PUBLIC (sessionless) route, so it must
 * prove the signer's identity the same way: a signature verified by the
 * IdentityVerificationGatekeeper. Without this gate, anyone who learns an
 * approval id could force-deny a pending approval and grief the legitimate
 * signer (denial-of-service on the approval flow — #10117).
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

const DenySchema = z.object({
  signature: z.string().min(1).max(4096),
  expectedSignerIdentityId: z.string().min(1).max(256).optional(),
  reason: z.string().max(500).optional(),
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
    const parsed = DenySchema.safeParse(body);
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
    // Prove the signer's identity before allowing the denial — symmetric with
    // /approve. A sessionless caller without the signer's key cannot deny.
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

    const approvalRequest = await service.markDenied(id, parsed.data.reason);

    await approvalCallbackBus.publish({
      name: "ApprovalDenied",
      approvalRequestId: id,
      reason: parsed.data.reason,
      deniedAt: new Date(),
    });

    return c.json({ success: true, approvalRequest });
  } catch (error) {
    logger.error("[ApprovalRequests API] Failed to deny approval request", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
