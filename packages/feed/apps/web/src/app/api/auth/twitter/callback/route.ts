/**
 * Twitter OAuth Callback API
 *
 * @route GET /api/auth/twitter/callback - Handle Twitter OAuth callback
 * @access Public (with state validation)
 *
 * @description
 * Handles OAuth callback from Twitter, exchanges code for token, fetches profile,
 * links Twitter account, and awards points. Redirects to rewards page with status.
 *
 * @openapi
 * /api/auth/twitter/callback:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Handle Twitter OAuth callback
 *     description: Processes OAuth callback and links Twitter account (redirects to rewards page)
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: Authorization code from Twitter
 *       - in: query
 *         name: state
 *         required: true
 *         schema:
 *           type: string
 *         description: State parameter (userId|timestamp|nonce)
 *       - in: query
 *         name: error
 *         schema:
 *           type: string
 *         description: OAuth error if authorization failed
 *     responses:
 *       302:
 *         description: Redirect to rewards page
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: /rewards?success=twitter_linked&reputation=100
 *       400:
 *         description: Invalid parameters or state expired
 *
 * @example
 * ```typescript
 * // Twitter redirects to:
 * // /api/auth/twitter/callback?code=abc123&state=user-id|timestamp|nonce
 *
 * // On success, user redirected to:
 * // /rewards?success=twitter_linked&reputation=100
 * ```
 *
 * @see {@link /api/auth/twitter/initiate} OAuth initiation
 * @see {@link /lib/services/points-service} Points service
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

const TwitterCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  const searchParams = request.nextUrl.searchParams;
  const parsed = TwitterCallbackQuerySchema.safeParse(
    Object.fromEntries(searchParams),
  );

  // Use the waitlist URL as base for all redirects
  const baseUrl = getWaitlistBaseUrl();

  if (!parsed.success) {
    return NextResponse.redirect(
      new URL(
        `${OAUTH_REDIRECT_PATH}?error=${encodeURIComponent("Invalid parameters received from Twitter")}`,
        baseUrl,
      ),
    );
  }

  const { code, state, error: oauthError } = parsed.data;

  // Handle OAuth error
  if (oauthError) {
    logger.error("Twitter OAuth error", { oauthError }, "TwitterCallback");
    return NextResponse.redirect(
      new URL(
        `${OAUTH_REDIRECT_PATH}?error=${encodeURIComponent("Twitter authentication failed")}`,
        baseUrl,
      ),
    );
  }

  if (!code || !state) {
    logger.warn(
      "Twitter callback missing code or state",
      { hasCode: !!code, hasState: !!state },
      "TwitterCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=missing_params`, baseUrl),
    );
  }

  // Verify state and get user ID from it
  // State format: "userId|timestamp|random" (using | to avoid conflicts with Privy DIDs)
  const stateParts = state.split("|");
  if (stateParts.length < 2) {
    logger.warn(
      "Twitter callback invalid state format",
      { state },
      "TwitterCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_state`, baseUrl),
    );
  }

  const [userId, timestampStr] = stateParts;
  if (!userId || !timestampStr) {
    logger.warn(
      "Twitter callback missing userId or timestamp in state",
      { state },
      "TwitterCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_state`, baseUrl),
    );
  }

  const stateTimestamp = Number.parseInt(timestampStr, 10);
  if (Number.isNaN(stateTimestamp)) {
    logger.warn(
      "Twitter callback invalid timestamp in state",
      { state, timestampStr },
      "TwitterCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_state`, baseUrl),
    );
  }

  const now = Date.now();

  // State expires after 10 minutes
  if (now - stateTimestamp > 10 * 60 * 1000) {
    logger.warn(
      "Twitter callback state expired",
      { stateTimestamp, now, ageMs: now - stateTimestamp },
      "TwitterCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=state_expired`, baseUrl),
    );
  }

  // Retrieve PKCE code verifier from database
  const oauthState = await db.oAuthState.findFirst({
    where: {
      state,
      returnPath: "twitter", // Provider stored in returnPath
      userId,
      expiresAt: { gte: new Date() },
    },
  });

  if (!oauthState?.codeVerifier) {
    logger.warn(
      "Twitter callback missing or expired PKCE state",
      {
        state,
        userId,
        found: !!oauthState,
      },
      "TwitterCallback",
    );

    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_state`, baseUrl),
    );
  }

  // Exchange code for access token with PKCE verifier
  const tokenResponse = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`,
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: `${getWaitlistBaseUrl()}/api/auth/twitter/callback`,
      code_verifier: oauthState.codeVerifier,
    }),
  });

  // Clean up OAuth state after use
  await db.oAuthState
    .delete({
      where: { id: oauthState.id },
    })
    .catch((error) => {
      logger.warn(
        "Failed to delete OAuth state",
        { error, stateId: oauthState.id },
        "TwitterCallback",
      );
    });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    logger.error(
      "Failed to exchange Twitter code",
      { errorData },
      "TwitterCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=token_exchange_failed`, baseUrl),
    );
  }

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;

  // Get user info from Twitter - fetch comprehensive profile data
  const userResponse = await fetch(
    "https://api.twitter.com/2/users/me?user.fields=username,name,profile_image_url,description",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!userResponse.ok) {
    logger.error("Failed to get Twitter user info", {}, "TwitterCallback");
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=failed_to_get_user`, baseUrl),
    );
  }

  const userData = (await userResponse.json()) as {
    data?: {
      id?: string;
      username?: string;
      name?: string;
      profile_image_url?: string;
      description?: string;
    };
  };

  if (!userData.data?.id || !userData.data?.username) {
    logger.error(
      "Invalid Twitter user data received",
      { userData },
      "TwitterCallback",
    );
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=invalid_twitter_data`, baseUrl),
    );
  }

  const twitterUser = userData.data;
  const twitterUsername = twitterUser.username;
  const twitterId = twitterUser.id;

  // Check if Twitter account is already linked to another user
  const existingLink = await db.user.findFirst({
    where: {
      twitterId,
      id: { not: userId },
    },
  });

  if (existingLink) {
    return NextResponse.redirect(
      new URL(`${OAUTH_REDIRECT_PATH}?error=twitter_already_linked`, baseUrl),
    );
  }

  // Update user with Twitter info
  await db.user.update({
    where: { id: userId },
    data: {
      twitterId,
      twitterUsername,
      hasTwitter: true,
      twitterAccessToken: accessToken, // Store encrypted in production
      twitterRefreshToken: tokenData.refresh_token,
      twitterTokenExpiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
    },
  });

  // Award points if this is the first time linking Twitter
  const pointsResult = await ReputationService.awardTwitterLink(
    userId,
    twitterUsername,
  );

  // Check if this qualifies a referral (award bonus to referrer)
  if (pointsResult.success) {
    await ReputationService.checkAndQualifyReferral(userId).catch((error) => {
      // Log error but don't fail the request if qualification check fails
      logger.warn(
        `Failed to check and qualify referral for user ${userId}`,
        { userId, error },
        "TwitterCallback",
      );
    });
  }

  logger.info(
    "Twitter account linked successfully",
    {
      userId,
      twitterUsername,
      reputationAwarded: pointsResult.reputationAwarded,
    },
    "TwitterCallback",
  );

  // Redirect back to configured destination with success
  return NextResponse.redirect(
    new URL(
      `${OAUTH_REDIRECT_PATH}?success=twitter_linked&reputation=${pointsResult.reputationAwarded}`,
      baseUrl,
    ),
  );
});
