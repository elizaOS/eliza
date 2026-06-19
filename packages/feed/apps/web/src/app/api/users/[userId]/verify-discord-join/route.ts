/**
 * User Verify Discord Join API
 *
 * @route POST /api/users/[userId]/verify-discord-join - Verify Discord guild membership
 * @access Authenticated
 *
 * @description
 * Verifies that a user has joined the Feed Discord server using Discord OAuth token.
 * Awards points if verification succeeds (trusted reward system).
 */

import {
  AuthorizationError,
  authenticate,
  BusinessLogicError,
  invalidateCache,
  ReputationService,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { db, eq, users } from "@feed/db";
import { logger, UserIdParamSchema } from "@feed/shared";
import type { NextRequest } from "next/server";

// Feed Discord Guild ID
const FEED_DISCORD_GUILD_ID =
  process.env.DISCORD_GUILD_ID || "1438561373012627456";

/**
 * POST /api/users/[userId]/verify-discord-join
 * Verify that a user has joined the Feed Discord server
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    // Authenticate user
    const authUser = await authenticate(request);
    const { userId } = UserIdParamSchema.parse(await context.params);

    // Check if the authenticated user has a database record
    if (!authUser.dbUserId) {
      throw new AuthorizationError(
        "User profile not found. Please complete onboarding first.",
        "discord-join-verification",
        "create",
      );
    }

    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    // Verify user is verifying their own Discord join
    if (authUser.dbUserId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only verify your own Discord membership",
        "discord-join-verification",
        "create",
      );
    }

    // Get user's Discord info
    const [user] = await db
      .select({
        discordUsername: users.discordUsername,
        discordId: users.discordId,
        discordAccessToken: users.discordAccessToken,
        pointsAwardedForDiscordJoin: users.pointsAwardedForDiscordJoin,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    // VALIDATION: Check if user has linked Discord account
    if (!user?.discordUsername || !user?.discordId) {
      throw new BusinessLogicError(
        "Please link your Discord account first to verify join.",
        "DISCORD_NOT_LINKED",
      );
    }

    if (!user.discordAccessToken) {
      throw new BusinessLogicError(
        "Discord access token not found. Please re-link your Discord account.",
        "DISCORD_TOKEN_MISSING",
      );
    }

    const alreadyAwarded = user.pointsAwardedForDiscordJoin;

    // Check if Discord Guild ID is configured
    if (!FEED_DISCORD_GUILD_ID) {
      throw new BusinessLogicError(
        "Discord verification is not configured. Please contact support.",
        "DISCORD_GUILD_NOT_CONFIGURED",
      );
    }

    // Verify guild membership using Discord API
    let isMember = false;
    let verificationError: string | null = null;

    logger.info(
      "Attempting to verify Discord guild membership",
      {
        userId: canonicalUserId,
        discordId: user.discordId,
        guildId: FEED_DISCORD_GUILD_ID,
      },
      "POST /api/users/[userId]/verify-discord-join",
    );

    // Use Discord API to get user's guilds
    const discordResponse = await fetch(
      "https://discord.com/api/v10/users/@me/guilds",
      {
        headers: {
          Authorization: `Bearer ${user.discordAccessToken}`,
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      },
    );

    if (discordResponse.ok) {
      const guilds: Array<{ id: string; name: string }> =
        await discordResponse.json();

      logger.info(
        "Discord API response received",
        { userId: canonicalUserId, guildsCount: guilds.length },
        "POST /api/users/[userId]/verify-discord-join",
      );

      // Check if Feed guild is in the list
      const feedGuild = guilds.find(
        (guild) => guild.id === FEED_DISCORD_GUILD_ID,
      );

      if (feedGuild) {
        isMember = true;
        logger.info(
          "User is a member of Feed Discord",
          { userId: canonicalUserId, discordId: user.discordId },
          "POST /api/users/[userId]/verify-discord-join",
        );
      } else {
        verificationError =
          "You are not a member of the Feed Discord server. Please join first.";
        logger.warn(
          "User is not a member of Feed Discord",
          {
            userId: canonicalUserId,
            discordId: user.discordId,
            guildsChecked: guilds.length,
          },
          "POST /api/users/[userId]/verify-discord-join",
        );
      }
    } else if (discordResponse.status === 401) {
      const errorBody = await discordResponse.text().catch(() => "");
      verificationError =
        "Discord authentication failed. Please re-link your Discord account.";
      logger.warn(
        "Discord token expired or invalid",
        { userId: canonicalUserId, discordId: user.discordId, errorBody },
        "POST /api/users/[userId]/verify-discord-join",
      );
    } else {
      const errorText = await discordResponse.text().catch(() => "");
      verificationError = `Discord API error (${discordResponse.status}). Please try again later.`;
      logger.error(
        "Discord API error",
        {
          userId: canonicalUserId,
          discordId: user.discordId,
          status: discordResponse.status,
          error: errorText,
        },
        "POST /api/users/[userId]/verify-discord-join",
      );
    }

    // If not a member, return error
    if (!isMember) {
      return successResponse({
        verified: false,
        message:
          verificationError ||
          "Could not verify membership. Please ensure you have joined the Feed Discord server.",
        reputation: {
          awarded: 0,
          newReputationTotal: 0,
        },
      });
    }

    // Award reputation only if verification succeeded and not already awarded.
    let reputationAwarded = 0;
    let newReputationTotal = 0;

    if (!alreadyAwarded) {
      // Award reputation through ReputationService.
      const reputationResult = await ReputationService.awardDiscordJoin(
        canonicalUserId,
        user.discordUsername,
      );

      if (reputationResult.success) {
        reputationAwarded = reputationResult.reputationAwarded;
        newReputationTotal = reputationResult.newReputationTotal;

        // Ensure the waitlist dashboard reflects new reputation immediately.
        await invalidateCache(canonicalUserId, {
          namespace: "waitlist:position",
        });

        logger.info(
          `Awarded ${reputationAwarded} reputation for Discord join`,
          { userId: canonicalUserId, reputationAwarded },
          "POST /api/users/[userId]/verify-discord-join",
        );
      }
    } else {
      // Already awarded, but still successful verification
      logger.info(
        "Discord membership already verified (no additional points)",
        { userId: canonicalUserId },
        "POST /api/users/[userId]/verify-discord-join",
      );
    }

    return successResponse({
      verified: true,
      message:
        reputationAwarded > 0
          ? `Discord membership verified! You earned ${reputationAwarded} reputation.`
          : "Membership verified! You already received reputation for this action.",
      reputation: {
        awarded: reputationAwarded,
        newReputationTotal,
      },
    });
  },
);
