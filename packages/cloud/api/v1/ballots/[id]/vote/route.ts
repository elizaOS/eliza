/**
 * Secret ballot — submit a vote.
 *
 * POST /api/v1/ballots/:id/vote   UNAUTHED — gated on per-participant token.
 *
 * The caller supplies the scoped token they were given out-of-band when the
 * ballot was created/distributed. The service hashes it, locates the
 * participant, and records (or idempotently replays) the vote.
 */

import { Hono } from "hono";
import { z } from "zod";
import { secretBallotsRepository } from "@/db/repositories/secret-ballots";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { createSecretBallotsService } from "@/lib/services/secret-ballots";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const VoteSchema = z.object({
  scopedToken: z.string().min(8).max(512),
  value: z.string().min(1).max(2048),
});

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing ballot id" }, 400);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = VoteSchema.safeParse(body);
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

    const service = createSecretBallotsService({
      repository: secretBallotsRepository,
    });
    const result = await service.submitVote({
      ballotId: id,
      scopedToken: parsed.data.scopedToken,
      value: parsed.data.value,
    });

    if (!result.ok) {
      const status = result.reason === "ballot_not_found" ? 404 : 409;
      return c.json({ success: false, error: result.reason }, status);
    }

    return c.json({
      success: true,
      outcome: result.outcome,
      ballotStatus: result.ballotStatus,
    });
  } catch (error) {
    logger.error("[SecretBallots API] Failed to submit ballot vote", { error });
    return failureResponse(c, error);
  }
});

export default app;
