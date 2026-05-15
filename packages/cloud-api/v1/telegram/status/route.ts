/**
 * Telegram Status API
 *
 * Returns the connection status of Telegram for the organization.
 * Includes webhook info from Telegram API for debugging.
 */

import { Hono } from "hono";
import { Telegraf } from "telegraf";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const status = await telegramAutomationService.getConnectionStatus(user.organization_id);

    // Optionally include webhook info for debugging
    const includeWebhookInfo = c.req.query("webhook") === "true";

    let webhookInfo: {
      url?: string;
      hasCustomCertificate: boolean;
      pendingUpdateCount: number;
      ipAddress?: string;
      lastErrorDate?: number;
      lastErrorMessage?: string;
      maxConnections?: number;
      allowedUpdates?: string[];
    } | null = null;

    if (includeWebhookInfo && status.connected) {
      const botToken = await telegramAutomationService.getBotToken(user.organization_id);
      if (botToken) {
        const bot = new Telegraf(botToken);
        const info = await bot.telegram.getWebhookInfo();
        webhookInfo = {
          url: info.url,
          hasCustomCertificate: info.has_custom_certificate,
          pendingUpdateCount: info.pending_update_count,
          ipAddress: info.ip_address,
          lastErrorDate: info.last_error_date,
          lastErrorMessage: info.last_error_message,
          maxConnections: info.max_connections,
          allowedUpdates: info.allowed_updates,
        };

        logger.info("[Telegram Status] Webhook info retrieved", {
          organizationId: user.organization_id,
          webhookUrl: info.url,
          pendingUpdates: info.pending_update_count,
          lastError: info.last_error_message,
        });
      }
    }

    return c.json({
      configured: status.configured,
      connected: status.connected,
      botUsername: status.botUsername,
      botId: status.botId,
      error: status.error,
      webhookUrl: telegramAutomationService.getWebhookUrl(user.organization_id),
      webhookInfo,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
