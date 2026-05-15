/**
 * OAuth intents — cancel (Wave C).
 *
 * POST /api/v1/oauth-intents/:id/cancel  (authed creator)
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { redactOAuthIntentForPublic } from "@/lib/services/oauth-intents";
import { getOAuthIntentsService } from "@/lib/services/oauth-intents-default";
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
      return c.json({ success: false, error: "Missing oauth intent id" }, 400);
    }

    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = CancelSchema.safeParse(rawBody ?? {});
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
