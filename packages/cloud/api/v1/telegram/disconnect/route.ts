/**
 * Telegram Disconnect API
 *
 * Removes bot credentials and webhook for the organization.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { invalidateOAuthState } from "@elizaos/cloud-shared/lib/services/oauth/invalidation";
import { telegramAutomationService } from "@elizaos/cloud-shared/lib/services/telegram-automation";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    await telegramAutomationService.removeCredentials(
      user.organization_id,
      user.id,
    );

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
