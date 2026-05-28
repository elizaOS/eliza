/**
 * Discord OAuth Initiation API
 *
 * @route GET /api/auth/discord/initiate - Initiate Discord OAuth
 * @access Authenticated
 *
 * @description
 * Initiates Discord OAuth 2.0 flow, redirecting user to Discord
 * authorization page. Generates secure state parameter with CSRF protection.
 */

import { authenticate, withErrorHandling } from "@feed/api";
import { db } from "@feed/db";
import {
  generateSnowflakeId,
  getWaitlistBaseUrl,
  logger,
  toISO,
} from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const authUser = await authenticate(request);
  const userId = authUser.userId;

  // Use | as separator instead of : to avoid conflicts with legacy provider IDs (steward:test:...)
  const state = `${userId}|${Date.now()}|${Math.random().toString(36).substring(7)}`;

  // Store state temporarily (expires in 10 minutes)
  // Discord doesn't use PKCE, but we need a placeholder for the DB schema
  const oauthRecord = await db.oAuthState.create({
    data: {
      id: await generateSnowflakeId(),
      userId,
      state,
      codeVerifier: "discord-oauth", // Placeholder since Discord doesn't use PKCE
      returnPath: "discord", // Use returnPath to store provider
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  logger.info(
    "Created OAuth state record",
    {
      userId,
      state,
      oauthRecordId: oauthRecord.id,
      expiresAt: toISO(oauthRecord.expiresAt),
    },
    "DiscordInitiate",
  );

  const authUrl = new URL("https://discord.com/api/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID!);
  authUrl.searchParams.set(
    "redirect_uri",
    `${getWaitlistBaseUrl()}/api/auth/discord/callback`,
  );
  authUrl.searchParams.set("scope", "identify guilds");
  authUrl.searchParams.set("state", state);

  logger.info(
    "Initiating Discord OAuth",
    { userId, state: `${state.substring(0, 20)}...` },
    "DiscordInitiate",
  );

  return NextResponse.redirect(authUrl.toString());
});
