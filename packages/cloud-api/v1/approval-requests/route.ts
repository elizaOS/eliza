/**
 * Approval requests — collection routes (Wave D).
 *
 * POST  /api/v1/approval-requests   Create an approval request (authed challenger).
 * GET   /api/v1/approval-requests   List approval requests for the caller's org.
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
import {
  type ApprovalRequestsService,
  createApprovalRequestsService,
} from "@/lib/services/approval-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ChallengeKindSchema = z.enum(["login", "signature", "generic"]);
const StatusSchema = z.enum([
  "pending",
  "delivered",
  "approved",
  "denied",
  "expired",
  "canceled",
]);
const SignerKindSchema = z.enum(["wallet", "ed25519"]);

const ChallengePayloadSchema = z.object({
  message: z.string().min(1).max(8192),
  signerKind: SignerKindSchema.optional(),
  walletAddress: z.string().min(1).max(256).optional(),
  publicKey: z.string().min(1).max(1024).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const CreateApprovalRequestSchema = z.object({
  challengeKind: ChallengeKindSchema,
  challengePayload: ChallengePayloadSchema,
  expectedSignerIdentityId: z.string().min(1).max(256).optional(),
  agentId: z.string().min(1).max(256).optional(),
  expiresInMs: z
    .number()
    .int()
    .min(30_000)
    .max(24 * 60 * 60 * 1000)
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ListQuerySchema = z.object({
  status: StatusSchema.optional(),
  challengeKind: ChallengeKindSchema.optional(),
  agentId: z.string().min(1).max(256).optional(),
  expectedSignerIdentityId: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
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

    const body = await c.req.json().catch(() => null);
    const parsed = CreateApprovalRequestSchema.safeParse(body);
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
    const approvalRequest = await service.create({
      organizationId: user.organization_id,
      agentId: parsed.data.agentId,
      userId: user.id,
      challengeKind: parsed.data.challengeKind,
      challengePayload: parsed.data.challengePayload,
      expectedSignerIdentityId: parsed.data.expectedSignerIdentityId,
      expiresInMs: parsed.data.expiresInMs,
      metadata: parsed.data.metadata,
    });

    return c.json({ success: true, approvalRequest });
  } catch (error) {
    logger.error("[ApprovalRequests API] Failed to create approval request", {
      error,
    });
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const parsed = ListQuerySchema.safeParse({
      status: c.req.query("status"),
      challengeKind: c.req.query("challengeKind"),
      agentId: c.req.query("agentId"),
      expectedSignerIdentityId: c.req.query("expectedSignerIdentityId"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid query",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const service = getApprovalRequestsService();
    const approvalRequests = await service.list(user.organization_id, {
      status: parsed.data.status,
      challengeKind: parsed.data.challengeKind,
      agentId: parsed.data.agentId,
      expectedSignerIdentityId: parsed.data.expectedSignerIdentityId,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    return c.json({ success: true, approvalRequests });
  } catch (error) {
    logger.error("[ApprovalRequests API] Failed to list approval requests", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
