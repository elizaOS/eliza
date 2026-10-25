/**
 * Discord Channels API
 *
 * Returns the list of channels for a guild.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { discordAutomationService } from "@elizaos/cloud-shared/lib/services/discord-automation";
import { getChannelTypeName } from "@elizaos/cloud-shared/lib/utils/discord-helpers";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const guildId = c.req.query("guildId");

    if (!guildId) {
      return c.json({ error: "guildId required" }, 400);
    }

    // Verify the guild belongs to this organization
    const guild = await discordAutomationService.getGuild(
      user.organization_id,
      guildId,
    );
    if (!guild) {
      return c.json({ error: "Guild not found" }, 404);
    }

    const channels = await discordAutomationService.getChannels(
      user.organization_id,
      guildId,
    );

    return c.json({
      channels: channels.map((ch) => ({
        id: ch.channel_id,
        name: ch.channel_name,
        type: ch.channel_type,
        typeName: getChannelTypeName(ch.channel_type),
        canSend: ch.can_send_messages,
        parentId: ch.parent_id,
        position: ch.position,
        isNsfw: ch.is_nsfw,
      })),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
