/**
 * Secret ballot — distribute participant tokens.
 *
 * POST /api/v1/ballots/:id/distribute  (authed creator)
 *
 * Wave G v1 supports DM-only distribution. Other targets are rejected with
 * a structured error so the agent action layer can present a clear failure.
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

const DistributeSchema = z.object({
  target: z.literal("dm"),
});

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing ballot id" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = DistributeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request: only 'dm' target is supported for ballot distribution",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const service = createSecretBallotsService({ repository: secretBallotsRepository });
    const ballot = await service.get(id, user.organization_id);
    if (!ballot) {
      return c.json({ success: false, error: "Ballot not found" }, 404);
    }

    const result = await service.distribute({ ballotId: id, target: parsed.data.target });
    return c.json({ success: true, ...result });
  } catch (error) {
    logger.error("[SecretBallots API] Failed to distribute ballot", { error });
    return failureResponse(c, error);
  }
});

export default app;
