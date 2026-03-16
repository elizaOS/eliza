/**
 * Discord OAuth Callback API
 *
 * Handles the OAuth2 callback after user authorizes the bot.
 * For bot OAuth (scope=bot), Discord returns guild_id directly in URL params.
 */

import { NextRequest, NextResponse } from "next/server";
import { discordAutomationService } from "@/lib/services/discord-automation";
import { logger } from "@/lib/utils/logger";

export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const guildId = searchParams.get("guild_id");
  const permissions = searchParams.get("permissions");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Parse state for return URL (do this early for error redirects)
  let returnUrl = "/dashboard/settings?tab=connections";
  if (state) {
    try {
      const stateData = JSON.parse(Buffer.from(state, "base64").toString());
      if (stateData.returnUrl) {
        returnUrl = stateData.returnUrl;
      }
    } catch {
      // Use default return URL
    }
  }

  // Handle OAuth errors (user cancelled, etc.)
  if (error) {
    logger.warn("[Discord Callback] OAuth error", { error, errorDescription });
    const errorUrl = `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}discord=error&message=${encodeURIComponent(
      errorDescription || error,
    )}`;
    return NextResponse.redirect(new URL(errorUrl, baseUrl));
  }

  // For bot OAuth, guild_id is returned directly in URL params
  if (!guildId || !state) {
    logger.warn("[Discord Callback] Missing params", {
      hasGuildId: !!guildId,
      hasState: !!state,
      hasCode: !!code,
    });
    return NextResponse.redirect(
      new URL(
        `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}discord=error&message=missing_params`,
        baseUrl,
      ),
    );
  }

  try {
    const result = await discordAutomationService.handleBotOAuthCallback(
      guildId,
      state,
      permissions || undefined,
    );

    if (result.success) {
      const successUrl = `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}discord=connected&guildId=${result.guildId}&guildName=${encodeURIComponent(result.guildName || "")}`;
      return NextResponse.redirect(new URL(successUrl, baseUrl));
    } else {
      const errorUrl = `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}discord=error&message=${encodeURIComponent(result.error || "unknown")}`;
      return NextResponse.redirect(new URL(errorUrl, baseUrl));
    }
  } catch (error) {
    logger.error("[Discord Callback] Unexpected error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.redirect(
      new URL(
        `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}discord=error&message=callback_failed`,
        baseUrl,
      ),
    );
  }
}
