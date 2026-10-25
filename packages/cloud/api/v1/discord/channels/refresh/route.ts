/**
 * Discord Channels Refresh API
 *
 * Refreshes the channel list for a guild from Discord API.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { discordAutomationService } from "@elizaos/cloud-shared/lib/services/discord-automation";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<AppEnv>();

const refreshSchema = z.object({
  guildId: z.string().min(1, "guildId required"),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    let body: z.infer<typeof refreshSchema>;
    try {
      const rawBody = await c.req.json();
      body = refreshSchema.parse(rawBody);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(
          { error: "Validation failed", details: error.flatten() },
          400,
        );
      }
      return c.json({ error: "Invalid request body" }, 400);
    }

    // Verify the guild belongs to this organization
    const guild = await discordAutomationService.getGuild(
      user.organization_id,
      body.guildId,
    );
    if (!guild) {
      return c.json({ error: "Guild not found" }, 404);
    }

    const channels = await discordAutomationService.refreshChannels(
      user.organization_id,
      body.guildId,
    );

    return c.json({
      success: true,
      channelCount: channels.length,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
