/**
 * Secret ballot — cancel.
 *
 * POST /api/v1/ballots/:id/cancel  (authed creator)
 */

import { Hono } from "hono";
import { z } from "zod";
import { secretBallotsRepository } from "@/db/repositories/secret-ballots";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { createSecretBallotsService } from "@/lib/services/secret-ballots";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CancelSchema = z.object({
  reason: z.string().max(500).optional(),
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
    const service = createSecretBallotsService({
      repository: secretBallotsRepository,
    });
    const ballot = await service.cancel({
      ballotId: id,
      organizationId: user.organization_id,
      reason: parsed.data.reason,
    });
    return c.json({ success: true, ballot });
  } catch (error) {
    logger.error("[SecretBallots API] Failed to cancel ballot", { error });
    return failureResponse(c, error);
  }
});

export default app;
