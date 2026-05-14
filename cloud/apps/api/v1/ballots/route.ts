/**
 * Secret ballots — collection routes.
 *
 * POST  /api/v1/ballots   Create a new secret ballot (authed creator).
 * GET   /api/v1/ballots   List ballots for the caller's org.
 *
 * Creating a ballot returns one-time scoped tokens, one per participant.
 * Those tokens are NEVER persisted in plaintext — only sha256 hashes are
 * stored on the ballot row, and the caller is responsible for distributing
 * each token privately (typically via the DM target).
 */

import { Hono } from "hono";
import { z } from "zod";
import { secretBallotsRepository } from "@/db/repositories/secret-ballots";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { createSecretBallotsService } from "@/lib/services/secret-ballots";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ParticipantSchema = z.object({
  identityId: z.string().min(1).max(256),
  label: z.string().min(1).max(120).optional(),
  channelHint: z.string().min(1).max(256).optional(),
});

const CreateBallotSchema = z.object({
  purpose: z.string().min(1).max(500),
  participants: z.array(ParticipantSchema).min(1).max(64),
  threshold: z.number().int().min(1).max(64),
  expiresInMs: z
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60 * 1000)
    .optional(),
  agentId: z.string().min(1).max(256).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const StatusSchema = z.enum(["open", "tallied", "expired", "canceled"]);

const ListQuerySchema = z.object({
  status: StatusSchema.optional(),
  agentId: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

function buildService() {
  return createSecretBallotsService({ repository: secretBallotsRepository });
}

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json().catch(() => null);
    const parsed = CreateBallotSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }
    if (parsed.data.threshold > parsed.data.participants.length) {
      return c.json(
        { success: false, error: "threshold cannot exceed participant count" },
        400,
      );
    }

    const service = buildService();
    const result = await service.create({
      organizationId: user.organization_id,
      agentId: parsed.data.agentId,
      purpose: parsed.data.purpose,
      participants: parsed.data.participants,
      threshold: parsed.data.threshold,
      expiresInMs: parsed.data.expiresInMs,
      metadata: parsed.data.metadata,
    });

    return c.json({
      success: true,
      ballot: result.ballot,
      ballotId: result.ballotId,
      expiresAt: result.expiresAt.toISOString(),
      participantTokens: result.participantTokens,
    });
  } catch (error) {
    logger.error("[SecretBallots API] Failed to create ballot", { error });
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = ListQuerySchema.safeParse({
      status: c.req.query("status"),
      agentId: c.req.query("agentId"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsed.success) {
      return c.json({ success: false, error: "Invalid query", details: parsed.error.issues }, 400);
    }
    const service = buildService();
    const ballots = await service.list(user.organization_id, parsed.data);
    return c.json({ success: true, ballots });
  } catch (error) {
    logger.error("[SecretBallots API] Failed to list ballots", { error });
    return failureResponse(c, error);
  }
});

export default app;
