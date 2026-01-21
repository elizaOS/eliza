/**
 * User Link Social API
 *
 * @route POST /api/users/[userId]/link-social - Link social account
 * @access Authenticated
 *
 * @description
 * Links a social account (Farcaster, Twitter, or wallet) to user profile.
 * Awards points if this is the first time linking this platform.
 *
 * @openapi
 * /api/users/{userId}/link-social:
 *   post:
 *     tags:
 *       - Users
 *     summary: Link social account
 *     description: Links social account and awards points if first time (authenticated user only)
 *     security:
 *       - PrivyAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - platform
 *             properties:
 *               platform:
 *                 type: string
 *                 enum: [farcaster, twitter, wallet]
 *               username:
 *                 type: string
 *                 description: Username for social platform
 *               address:
 *                 type: string
 *                 pattern: '^0x[a-fA-F0-9]{40}$'
 *                 description: Wallet address (for wallet platform)
 *     responses:
 *       200:
 *         description: Account linked successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not authorized for this user
 *       409:
 *         description: Account already linked
 *
 * @example
 * ```typescript
 * await fetch(`/api/users/${userId}/link-social`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     platform: 'farcaster',
 *     username: 'username'
 *   })
 * });
 * ```
 */

import {
  AuthorizationError,
  authenticate,
  ConflictError,
  NotFoundError,
  PointsService,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import { and, db, eq, ne, users } from "@polyagent/db";
import { logger, UserIdParamSchema } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { trackServerEvent } from "@/lib/posthog/server";

const LinkSocialRequestSchema = z.object({
  platform: z.enum(["farcaster", "twitter", "wallet"]),
  username: z.string().optional(),
  address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
});

/**
 * POST /api/users/[userId]/link-social
 *
 * Links a social account to the user profile and awards points if this is the first time linking this platform.
 *
 * @param request - Next.js request containing platform and account details
 * @param context - Route context with user ID parameter
 * @returns Success response with linked account information
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    // Authenticate user
    const authUser = await authenticate(request);
    const params = await context.params;
    const { userId } = UserIdParamSchema.parse(params);
    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    // Verify user is linking their own account
    if (authUser.userId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only link your own social accounts",
        "social-account",
        "link",
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const { platform, username, address } = LinkSocialRequestSchema.parse(body);

    // Get current user state
    const [user] = await db
      .select({
        hasFarcaster: users.hasFarcaster,
        hasTwitter: users.hasTwitter,
        walletAddress: users.walletAddress,
        farcasterFid: users.farcasterFid,
        twitterId: users.twitterId,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    if (!user) {
      throw new NotFoundError("User", canonicalUserId);
    }

    // Check if already linked
    let alreadyLinked = false;
    switch (platform) {
      case "farcaster":
        alreadyLinked = user.hasFarcaster;
        // Check if Farcaster username is already linked to another user
        if (username && !alreadyLinked) {
          const [existingFarcasterUser] = await db
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.farcasterUsername, username),
                ne(users.id, canonicalUserId),
              ),
            )
            .limit(1);
          if (existingFarcasterUser) {
            throw new ConflictError(
              "Farcaster account already linked to another user",
              "User.farcasterUsername",
            );
          }
        }
        break;
      case "twitter":
        alreadyLinked = user.hasTwitter;
        // Check if Twitter account is already linked to another user
        if (username && !alreadyLinked) {
          const [existingTwitterUser] = await db
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.twitterUsername, username),
                ne(users.id, canonicalUserId),
              ),
            )
            .limit(1);
          if (existingTwitterUser) {
            throw new ConflictError(
              "Twitter account already linked to another user",
              "User.twitterUsername",
            );
          }
        }
        break;
      case "wallet":
        alreadyLinked = !!user.walletAddress;
        break;
    }

    // Check if wallet address is already in use by another user
    if (platform === "wallet" && address) {
      const [existingWalletUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.walletAddress, address.toLowerCase()))
        .limit(1);

      if (existingWalletUser && existingWalletUser.id !== canonicalUserId) {
        throw new ConflictError(
          "Wallet address already linked to another account",
          "User.walletAddress",
        );
      }
    }

    // Update user with social connection
    const updateData: Partial<typeof users.$inferInsert> = {};
    switch (platform) {
      case "farcaster":
        updateData.hasFarcaster = true;
        if (username) updateData.farcasterUsername = username;
        break;
      case "twitter":
        updateData.hasTwitter = true;
        if (username) updateData.twitterUsername = username;
        break;
      case "wallet":
        if (address) updateData.walletAddress = address.toLowerCase();
        break;
    }

    await db.update(users).set(updateData).where(eq(users.id, canonicalUserId));

    // Award points if not already linked
    let pointsResult;
    if (!alreadyLinked) {
      switch (platform) {
        case "farcaster":
          pointsResult = await PointsService.awardFarcasterLink(
            canonicalUserId,
            username,
          );
          break;
        case "twitter":
          pointsResult = await PointsService.awardTwitterLink(
            canonicalUserId,
            username,
          );
          break;
        case "wallet":
          pointsResult = await PointsService.awardWalletConnect(
            canonicalUserId,
            address,
          );
          break;
      }

      // Check if this qualifies a referral (award bonus to referrer)
      // This happens after linking social account, so user now has at least one social account
      if (pointsResult?.success) {
        await PointsService.checkAndQualifyReferral(canonicalUserId).catch(
          (error) => {
            // Log error but don't fail the request if qualification check fails
            logger.warn(
              `Failed to check and qualify referral for user ${canonicalUserId}`,
              { userId: canonicalUserId, error },
              "POST /api/users/[userId]/link-social",
            );
          },
        );
      }
    }

    logger.info(
      `User ${canonicalUserId} linked ${platform} account`,
      { userId: canonicalUserId, platform, username, address, alreadyLinked },
      "POST /api/users/[userId]/link-social",
    );

    // Track social account linked event
    trackServerEvent(canonicalUserId, "social_account_linked", {
      platform,
      ...(username && { username }),
      ...(address && { address }),
      wasAlreadyLinked: alreadyLinked,
      pointsAwarded: pointsResult?.pointsAwarded || 0,
    }).catch((error) => {
      logger.warn("Failed to track social_account_linked event", { error });
    });

    return successResponse({
      platform,
      linked: true,
      alreadyLinked,
      points: pointsResult
        ? {
            awarded: pointsResult.pointsAwarded,
            newTotal: pointsResult.newTotal,
          }
        : null,
    });
  },
);
