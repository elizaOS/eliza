/**
 * Discord Status API
 *
 * Returns the connection status of Discord for the organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { discordAutomationService } from "@/lib/services/discord-automation";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    // Check if Discord OAuth is configured (for adding bot to servers)
    const isOAuthConfigured = discordAutomationService.isOAuthConfigured();
    // Check if bot can send messages (only needs bot token)
    const canSendMessages = discordAutomationService.canSendMessages();

    // If bot can't even send messages, it's not usable at all
    if (!canSendMessages) {
      return c.json({
        configured: false,
        connected: false,
        guilds: [],
        error: "Discord bot token not configured",
      });
    }

    const status = await discordAutomationService.getConnectionStatus(user.organization_id);

    return c.json({
      // configured = can users add bot to new servers (OAuth flow)
      configured: isOAuthConfigured,
      // connected = does org have guilds AND can bot send messages
      connected: status.connected,
      guilds: status.guilds,
      error: status.error,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
