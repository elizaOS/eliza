/**
 * OAuth intents — single resource (Wave C).
 *
 * GET   /api/v1/oauth-intents/:id   Authed creator view (full row minus
 *                                   stateTokenHash/pkceVerifierHash, which are
 *                                   internal).
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { redactOAuthIntentForPublic } from "@elizaos/cloud-shared/lib/services/oauth-intents";
import { getOAuthIntentsService } from "@elizaos/cloud-shared/lib/services/oauth-intents-default";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing oauth intent id" }, 400);
    }

    const user = await requireUserOrApiKeyWithOrg(c);
    const service = getOAuthIntentsService(c.env);
    const row = await service.get(id, user.organization_id);
    if (!row) {
      return c.json({ success: false, error: "OAuth intent not found" }, 404);
    }

    return c.json({
      success: true,
      oauthIntent: redactOAuthIntentForPublic(row),
    });
  } catch (error) {
    logger.error("[OAuthIntents API] Failed to get oauth intent", { error });
    return failureResponse(c, error);
  }
});

export default app;
