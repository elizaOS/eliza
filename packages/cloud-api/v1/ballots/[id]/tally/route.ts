/**
 * Secret ballot — tally if threshold met.
 *
 * POST /api/v1/ballots/:id/tally  (authed creator)
 *
 * Returns the tally result if the threshold has been reached and the
 * ballot is open or already tallied. Otherwise reports `tallied: false`.
 */

import { Hono } from "hono";
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

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing ballot id" }, 400);
    }
    const service = createSecretBallotsService({
      repository: secretBallotsRepository,
    });
    const ballot = await service.get(id, user.organization_id);
    if (!ballot) {
      return c.json({ success: false, error: "Ballot not found" }, 404);
    }
    const result = await service.tallyIfThresholdMet({ ballotId: id });
    return c.json({
      success: true,
      tallied: result.tallied,
      ballot: result.ballot,
      tallyResult: result.result,
    });
  } catch (error) {
    logger.error("[SecretBallots API] Failed to tally ballot", { error });
    return failureResponse(c, error);
  }
});

export default app;
