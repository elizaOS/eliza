/**
 * Telegram Connect API
 *
 * Validates a bot token and stores credentials for the organization.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { invalidateOAuthState } from "@elizaos/cloud-shared/lib/services/oauth/invalidation";
import { telegramAutomationService } from "@elizaos/cloud-shared/lib/services/telegram-automation";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<AppEnv>();

const connectSchema = z.object({
  botToken: z.string().min(30, "Invalid bot token"),
  channelId: z.string().optional(),
  groupId: z.string().optional(),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    let body: z.infer<typeof connectSchema>;
    try {
      const rawBody = await c.req.json();
      body = connectSchema.parse(rawBody);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(
          { error: "Validation failed", details: error.flatten() },
          400,
        );
      }
      return c.json({ error: "Invalid request body" }, 400);
    }

    const validation = await telegramAutomationService.validateBotToken(
      body.botToken,
    );
    if (!validation.valid || !validation.botInfo) {
      return c.json({ error: validation.error || "Invalid bot token" }, 400);
    }

    try {
      await telegramAutomationService.storeCredentials(
        user.organization_id,
        user.id,
        {
          botToken: body.botToken,
          botUsername: validation.botInfo.botUsername,
          botId: validation.botInfo.botId,
        },
      );
    } catch (error) {
      logger.error("[Telegram Connect] Failed to store credentials", {
        organizationId: user.organization_id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return c.json({ error: "Failed to store credentials" }, 500);
    }

    await invalidateOAuthState(user.organization_id, "telegram", user.id);

    const webhookResult = await telegramAutomationService.setWebhook(
      user.organization_id,
    );
    if (!webhookResult.success) {
      logger.warn("[Telegram Connect] Webhook setup failed", {
        organizationId: user.organization_id,
        error: webhookResult.error,
      });
    }

    logger.info("[Telegram Connect] Bot connected successfully", {
      organizationId: user.organization_id,
      botUsername: validation.botInfo.botUsername,
      webhookSet: webhookResult.success,
    });

    return c.json({
      success: true,
      botUsername: validation.botInfo.botUsername,
      botId: validation.botInfo.botId,
      firstName: validation.botInfo.firstName,
      webhookSet: webhookResult.success,
      canJoinGroups: validation.botInfo.canJoinGroups,
      canReadAllGroupMessages: validation.botInfo.canReadAllGroupMessages,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
