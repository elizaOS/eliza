/**
 * OAuth intents — cancel (Wave C).
 *
 * POST /api/v1/oauth-intents/:id/cancel  (authed creator)
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { redactOAuthIntentForPublic } from "@elizaos/cloud-shared/lib/services/oauth-intents";
import { getOAuthIntentsService } from "@elizaos/cloud-shared/lib/services/oauth-intents-default";
import { decodeOptionalRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

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
      return c.json({ success: false, error: "Missing oauth intent id" }, 400);
    }

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

    const service = getOAuthIntentsService(c.env);
    const oauthIntent = await service.cancel(
      id,
      user.organization_id,
      parsed.data.reason,
    );

    return c.json({
      success: true,
      oauthIntent: redactOAuthIntentForPublic(oauthIntent),
    });
  } catch (error) {
    logger.error("[OAuthIntents API] Failed to cancel oauth intent", { error });
    return failureResponse(c, error);
  }
});

export default app;
