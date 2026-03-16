/**
 * Discord OAuth API
 *
 * Initiates the OAuth2 flow to add the bot to a Discord server.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { discordAutomationService } from "@/lib/services/discord-automation";

export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  // Check if Discord is configured
  if (!discordAutomationService.isConfigured()) {
    return NextResponse.json(
      { error: "Discord integration not configured" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const returnUrl = searchParams.get("returnUrl") || "/dashboard/settings";

  const state = {
    organizationId: user.organization_id,
    userId: user.id,
    returnUrl,
    nonce: randomBytes(16).toString("hex"),
  };

  const oauthUrl = discordAutomationService.generateOAuthUrl(state);

  return NextResponse.redirect(oauthUrl);
}
