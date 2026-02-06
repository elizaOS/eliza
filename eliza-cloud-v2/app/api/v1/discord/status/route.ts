/**
 * Discord Status API
 *
 * Returns the connection status of Discord for the organization.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { discordAutomationService } from "@/lib/services/discord-automation";

export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  // Check if Discord OAuth is configured (for adding bot to servers)
  const isOAuthConfigured = discordAutomationService.isOAuthConfigured();
  // Check if bot can send messages (only needs bot token)
  const canSendMessages = discordAutomationService.canSendMessages();

  // If bot can't even send messages, it's not usable at all
  if (!canSendMessages) {
    return NextResponse.json({
      configured: false,
      connected: false,
      guilds: [],
      error: "Discord bot token not configured",
    });
  }

  const status = await discordAutomationService.getConnectionStatus(
    user.organization_id,
  );

  return NextResponse.json({
    // configured = can users add bot to new servers (OAuth flow)
    configured: isOAuthConfigured,
    // connected = does org have guilds AND can bot send messages
    connected: status.connected,
    guilds: status.guilds,
    error: status.error,
  });
}
