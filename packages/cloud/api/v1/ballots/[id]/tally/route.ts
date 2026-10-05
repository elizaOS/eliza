/**
 * Secret ballot — tally if threshold met.
 *
 * POST /api/v1/ballots/:id/tally  (authed creator)
 *
 * Returns the tally result if the threshold has been reached and the
 * ballot is open or already tallied. Otherwise reports `tallied: false`.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { secretBallotsRepository } from "@elizaos/cloud-shared/db/repositories/secret-ballots";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { createSecretBallotsService } from "@elizaos/cloud-shared/lib/services/secret-ballots";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { parseBallotIdParam } from "../../ballot-id";

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsedId = parseBallotIdParam(c.req.param("id"));
    if (!parsedId.ok) {
      return c.json({ success: false, error: parsedId.error }, 400);
    }
    const { id } = parsedId;
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
