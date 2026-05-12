/**
 * Telegram Disconnect API
 *
 * Removes bot credentials and webhook for the organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { invalidateOAuthState } from "@/lib/services/oauth/invalidation";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    await telegramAutomationService.removeCredentials(user.organization_id, user.id);

    await invalidateOAuthState(user.organization_id, "telegram", user.id);

    logger.info("[Telegram Disconnect] Bot disconnected successfully", {
      organizationId: user.organization_id,
    });

    return c.json({ success: true });
  } catch (error) {
    logger.error("[Telegram Disconnect] Failed to disconnect", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
});

export default app;
