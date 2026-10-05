/**
 * Secret ballot — cancel.
 *
 * POST /api/v1/ballots/:id/cancel  (authed creator)
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { secretBallotsRepository } from "@elizaos/cloud-shared/db/repositories/secret-ballots";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { createSecretBallotsService } from "@elizaos/cloud-shared/lib/services/secret-ballots";
import { decodeOptionalRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { parseBallotIdParam } from "../../ballot-id";

const CancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

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
    const decodedBody = await decodeOptionalRequestJson(c.req);
    if (!decodedBody.ok) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const parsed = CancelSchema.safeParse(decodedBody.value);
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
