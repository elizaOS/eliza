/**
 * Discord Guilds API
 *
 * Returns the list of connected Discord guilds (servers).
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { discordAutomationService } from "@elizaos/cloud-shared/lib/services/discord-automation";
import { getGuildIconUrl } from "@elizaos/cloud-shared/lib/utils/discord-helpers";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const guilds = await discordAutomationService.getGuilds(
      user.organization_id,
    );

    return c.json({
      guilds: guilds.map((g) => ({
        id: g.guild_id,
        name: g.guild_name,
        iconUrl: getGuildIconUrl(g.guild_id, g.icon_hash),
        joinedAt: g.bot_joined_at,
        isActive: g.is_active,
      })),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
