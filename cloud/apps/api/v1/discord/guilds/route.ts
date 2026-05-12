/**
 * Discord Guilds API
 *
 * Returns the list of connected Discord guilds (servers).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { discordAutomationService } from "@/lib/services/discord-automation";
import { getGuildIconUrl } from "@/lib/utils/discord-helpers";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const guilds = await discordAutomationService.getGuilds(user.organization_id);

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
