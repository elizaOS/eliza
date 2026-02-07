/**
 * Discord Channels Refresh API
 *
 * Refreshes the channel list for a guild from Discord API.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { discordAutomationService } from "@/lib/services/discord-automation";

export const maxDuration = 60;

const refreshSchema = z.object({
  guildId: z.string().min(1, "guildId required"),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  let body: z.infer<typeof refreshSchema>;
  try {
    const rawBody = await request.json();
    body = refreshSchema.parse(rawBody);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.flatten() },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  // Verify the guild belongs to this organization
  const guild = await discordAutomationService.getGuild(
    user.organization_id,
    body.guildId,
  );
  if (!guild) {
    return NextResponse.json({ error: "Guild not found" }, { status: 404 });
  }

  const channels = await discordAutomationService.refreshChannels(
    user.organization_id,
    body.guildId,
  );

  return NextResponse.json({
    success: true,
    channelCount: channels.length,
  });
}
