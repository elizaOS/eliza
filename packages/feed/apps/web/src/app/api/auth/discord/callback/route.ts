/**
 * Discord OAuth Callback API
 *
 * @route GET /api/auth/discord/callback - Handle Discord OAuth callback
 * @access Public (with state validation)
 *
 * @description
 * Handles OAuth callback from Discord, exchanges code for token, fetches profile,
 * links Discord account, and awards points. Redirects to rewards page with status.
 */

import { ReputationService, withErrorHandling } from "@feed/api";
import { db } from "@feed/db";
import { getWaitlistBaseUrl, logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

// Configurable redirect destination after OAuth completion.
// Treat empty string as "unset" to avoid redirecting to `/?success=...`.
const OAUTH_REDIRECT_PATH =
  process.env.OAUTH_REDIRECT_PATH?.trim() || "/rewards";

const DiscordCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  const searchParams = request.nextUrl.searchParams;
  const parsed = DiscordCallbackQuerySchema.safeParse(
    Object.fromEntries(searchParams),
  );

  // Use the waitlist URL as base for all redirects
  const baseUrl = getWaitlistBaseUrl();

  if (!parsed.success) {
    return NextResponse.redirect(
      new URL(
        `${OAUTH_REDIRECT_PATH}?error=${encodeURIComponent("Invalid parameters received from Discord")}`,
        baseUrl,
      ),
    );
  }

  const { code, state, error: oauthError } = parsed.data;

  // Handle OAuth error
  if (oauthError) {
    logger.error("Discord OAuth error", { oauthError }, "DiscordCallback");
    return NextResponse.redirect(
      new URL(
        `${OAUTH_REDIRECT_PATH}?error=${encodeURIComponent("Discord authentication failed")}`,
        baseUrl,
      ),
    );
  }

  if (!code || !state) {
    logger.warn(
      "Discord callback missing code or state",
      { hasCode: !!code, hasState: !!state },
      "DiscordCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=missing_params`, baseUrl),
    );
  }

  // Verify state and get user ID from it
  // State format: "userId|timestamp|random" (using | to avoid conflicts with legacy provider IDs)
  const stateParts = state.split("|");
  if (stateParts.length < 2) {
    logger.warn(
      "Discord callback invalid state format",
      { state },
      "DiscordCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_state`, baseUrl),
    );
  }

  const [userId, timestampStr] = stateParts;
  if (!userId || !timestampStr) {
    logger.warn(
      "Discord callback missing userId or timestamp in state",
      { state },
      "DiscordCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_state`, baseUrl),
    );
  }

  const stateTimestamp = Number.parseInt(timestampStr, 10);
  if (Number.isNaN(stateTimestamp)) {
    logger.warn(
      "Discord callback invalid timestamp in state",
      { state, timestampStr },
      "DiscordCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_state`, baseUrl),
    );
  }

  const now = Date.now();

  // State expires after 10 minutes
  if (now - stateTimestamp > 10 * 60 * 1000) {
    logger.warn(
      "Discord callback state expired",
      { stateTimestamp, now, ageMs: now - stateTimestamp },
      "DiscordCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=state_expired`, baseUrl),
    );
  }

  // Retrieve OAuth state from database
  const oauthState = await db.oAuthState.findFirst({
    where: {
      state,
      returnPath: "discord", // Provider stored in returnPath
      userId,
      expiresAt: { gte: new Date() },
    },
  });

  if (!oauthState) {
    logger.warn(
      "Discord callback missing or expired state",
      {
        state,
        userId,
      },
      "DiscordCallback",
    );

    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_state`, baseUrl),
    );
  }

  // Exchange code for access token
  const tokenResponse = await fetch(
    "https://discord.com/api/v10/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID!,
        client_secret: process.env.DISCORD_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${getWaitlistBaseUrl()}/api/auth/discord/callback`,
      }),
    },
  );

  // Clean up OAuth state after use
  await db.oAuthState
    .delete({
      where: { id: oauthState.id },
    })
    .catch((error) => {
      logger.warn(
        "Failed to delete OAuth state",
        { error, stateId: oauthState.id },
        "DiscordCallback",
      );
    });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    logger.error(
      "Failed to exchange Discord code",
      { errorData },
      "DiscordCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=token_exchange_failed`, baseUrl),
    );
  }

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;

  // Get user info from Discord
  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!userResponse.ok) {
    logger.error("Failed to get Discord user info", {}, "DiscordCallback");
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=failed_to_get_user`, baseUrl),
    );
  }

  const userData = (await userResponse.json()) as {
    id?: string;
    username?: string;
    discriminator?: string;
    global_name?: string;
    avatar?: string;
  };

  if (!userData.id || !userData.username) {
    logger.error(
      "Invalid Discord user data received",
      { userData },
      "DiscordCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_discord_data`, baseUrl),
    );
  }

  const discordId = userData.id;
  const discordUsername = userData.username;

  // Check if Discord account is already linked to another user
  const existingLink = await db.user.findFirst({
    where: {
      discordId,
      id: { not: userId },
    },
  });

  if (existingLink) {
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=discord_already_linked`, baseUrl),
    );
  }

  // Update user with Discord info
  await db.user.update({
    where: { id: userId },
    data: {
      discordId,
      discordUsername,
      hasDiscord: true,
      discordAccessToken: accessToken, // Store encrypted in production
      discordRefreshToken: tokenData.refresh_token,
      discordTokenExpiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
      discordVerifiedAt: new Date(),
    },
  });

  // Award points if this is the first time linking Discord
  const pointsResult = await ReputationService.awardDiscordLink(
    userId,
    discordUsername,
  );

  // Check if this qualifies a referral (award bonus to referrer)
  if (pointsResult.success) {
    await ReputationService.checkAndQualifyReferral(userId).catch((error) => {
      // Log error but don't fail the request if qualification check fails
      logger.warn(
        `Failed to check and qualify referral for user ${userId}`,
        { userId, error },
        "DiscordCallback",
      );
    });
  }

  logger.info(
    "Discord account linked successfully",
    {
      userId,
      discordUsername,
      reputationAwarded: pointsResult.reputationAwarded,
    },
    "DiscordCallback",
  );

  // Redirect back to configured destination with success
  return NextResponse.redirect(
    new URL(
      `${OAUTH_REDIRECT_PATH}?success=discord_linked&reputation=${pointsResult.reputationAwarded}`,
      baseUrl,
    ),
  );
});
