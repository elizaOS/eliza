/**
 * Discord Disconnect API
 *
 * Disconnects the bot from a Discord guild or all guilds.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { discordAutomationService } from "@/lib/services/discord-automation";
import { logger } from "@/lib/utils/logger";

export const maxDuration = 60;

const disconnectSchema = z.object({
  guildId: z.string().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  let body: z.infer<typeof disconnectSchema>;
  try {
    const rawBody = await request.json();
    body = disconnectSchema.parse(rawBody);
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

  if (body.guildId) {
    // Disconnect specific guild
    const guild = await discordAutomationService.getGuild(
      user.organization_id,
      body.guildId,
    );
    if (!guild) {
      return NextResponse.json({ error: "Guild not found" }, { status: 404 });
    }

    const result = await discordAutomationService.disconnect(
      user.organization_id,
      body.guildId,
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    logger.info("[Discord Disconnect] Guild disconnected", {
      organizationId: user.organization_id,
      guildId: body.guildId,
    });

    return NextResponse.json({ success: true });
  } else {
    // Disconnect all guilds
    await discordAutomationService.disconnectAll(user.organization_id);

    logger.info("[Discord Disconnect] All guilds disconnected", {
      organizationId: user.organization_id,
    });

    return NextResponse.json({ success: true });
  }
}
