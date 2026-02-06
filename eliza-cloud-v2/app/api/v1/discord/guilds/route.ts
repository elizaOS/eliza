/**
 * Discord Guilds API
 *
 * Returns the list of connected Discord guilds (servers).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { discordAutomationService } from "@/lib/services/discord-automation";
import { getGuildIconUrl } from "@/lib/utils/discord-helpers";

export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const guilds = await discordAutomationService.getGuilds(user.organization_id);

  return NextResponse.json({
    guilds: guilds.map((g) => ({
      id: g.guild_id,
      name: g.guild_name,
      iconUrl: getGuildIconUrl(g.guild_id, g.icon_hash),
      joinedAt: g.bot_joined_at,
      isActive: g.is_active,
    })),
  });
}
