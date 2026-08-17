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

const MAX_APPROVAL_REQUESTS_LIMIT = 200;

class ApprovalRequestsLimitError extends Error {
  constructor(message = "Invalid limit") {
    super(message);
    this.name = "ApprovalRequestsLimitError";
  }
}

/**
 * GET /api/v1/approval-requests `limit` is collection page-size identity,
 * leftover tax after approval-request `public` (#21135) and approvals
 * `state` (#20899). Stock develop used z.coerce.number(), which treated
 * `1e2` / `007` / `0x10` as a page size instead of a 400. offset /
 * status / challengeKind stay untouched. Missing / empty still means
 * the service default (no limit). Exact integers above 200 stay 400.
 */
function parseApprovalRequestsLimitQuery(
  searchParams: URLSearchParams,
): number | undefined {
  const requested = searchParams.getAll("limit");
  if (requested.length > 1) {
    throw new ApprovalRequestsLimitError();
  }
  const raw = requested[0];
  if (raw == null || raw === "") {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ApprovalRequestsLimitError();
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_APPROVAL_REQUESTS_LIMIT
  ) {
    throw new ApprovalRequestsLimitError();
  }
  return parsed;
}

const ListQuerySchema = z.object({
  status: StatusSchema.optional(),
  challengeKind: ChallengeKindSchema.optional(),
  agentId: z.string().min(1).max(256).optional(),
  expectedSignerIdentityId: z.string().min(1).max(256).optional(),
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

// error-policy:J1 every handler across the v1/approval-requests/* dir (this
// collection route plus [id], [id]/approve, [id]/deny, [id]/cancel) has one
// outermost try/catch that translates exceptions into a structured failure via
// failureResponse(c, error), with typed 400 for invalid input and 404 for a
// not-found row. No catch here fabricates a success or an empty result.
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

    let limit: number | undefined;
    try {
      limit = parseApprovalRequestsLimitQuery(
        new URL(c.req.url, "http://localhost").searchParams,
      );
    } catch (limitError) {
      if (limitError instanceof ApprovalRequestsLimitError) {
        return c.json({ success: false, error: limitError.message }, 400);
      }
      throw limitError;
    }

    const parsed = ListQuerySchema.safeParse({
      status: c.req.query("status"),
      challengeKind: c.req.query("challengeKind"),
      agentId: c.req.query("agentId"),
      expectedSignerIdentityId: c.req.query("expectedSignerIdentityId"),
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
      limit,
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
