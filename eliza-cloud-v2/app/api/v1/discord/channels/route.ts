/**
 * Discord Channels API
 *
 * Returns the list of channels for a guild.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { discordAutomationService } from "@/lib/services/discord-automation";
import { getChannelTypeName } from "@/lib/utils/discord-helpers";

export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const { searchParams } = new URL(request.url);
  const guildId = searchParams.get("guildId");

  if (!guildId) {
    return NextResponse.json({ error: "guildId required" }, { status: 400 });
  }

  // Verify the guild belongs to this organization
  const guild = await discordAutomationService.getGuild(
    user.organization_id,
    guildId,
  );
  if (!guild) {
    return NextResponse.json({ error: "Guild not found" }, { status: 404 });
  }

  const channels = await discordAutomationService.getChannels(
    user.organization_id,
    guildId,
  );

  return NextResponse.json({
    channels: channels.map((c) => ({
      id: c.channel_id,
      name: c.channel_name,
      type: c.channel_type,
      typeName: getChannelTypeName(c.channel_type),
      canSend: c.can_send_messages,
      parentId: c.parent_id,
      position: c.position,
      isNsfw: c.is_nsfw,
    })),
  });
}
