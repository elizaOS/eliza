/**
 * User Link Social API
 *
 * @route POST /api/users/[userId]/link-social - Link social account
 * @access Authenticated
 *
 * @description
 * Links a social account (Farcaster, Twitter) to user profile.
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
 *       - BearerAuth: []
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
 *                 enum: [farcaster, twitter]
 *               username:
 *                 type: string
 *                 description: Username for social platform
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
  ReputationService,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { and, db, eq, ne, users } from "@feed/db";
import { logger, UserIdParamSchema } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { trackServerEvent } from "@/lib/posthog/server";

const LinkSocialRequestSchema = z.object({
  platform: z.enum(["farcaster", "twitter"]),
  username: z.string().optional(),
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
    const { platform, username } = LinkSocialRequestSchema.parse(body);

    // Get current user state
    const [user] = await db
      .select({
        hasFarcaster: users.hasFarcaster,
        hasTwitter: users.hasTwitter,
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
    }

    await db.update(users).set(updateData).where(eq(users.id, canonicalUserId));

    // Award points if not already linked
    let pointsResult;
    if (!alreadyLinked) {
      switch (platform) {
        case "farcaster":
          pointsResult = await ReputationService.awardFarcasterLink(
            canonicalUserId,
            username,
          );
          break;
        case "twitter":
          pointsResult = await ReputationService.awardTwitterLink(
            canonicalUserId,
            username,
          );
          break;
      }

      // Check if this qualifies a referral (award bonus to referrer)
      // This happens after linking social account, so user now has at least one social account
      if (pointsResult?.success) {
        await ReputationService.checkAndQualifyReferral(canonicalUserId).catch(
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
      { userId: canonicalUserId, platform, username, alreadyLinked },
      "POST /api/users/[userId]/link-social",
    );

    // Track social account linked event
    trackServerEvent(canonicalUserId, "social_account_linked", {
      platform,
      ...(username && { username }),
      wasAlreadyLinked: alreadyLinked,
      reputationAwarded: pointsResult?.reputationAwarded || 0,
    }).catch((error) => {
      logger.warn("Failed to track social_account_linked event", { error });
    });

    return successResponse({
      platform,
      linked: true,
      alreadyLinked,
      reputation: pointsResult
        ? {
            awarded: pointsResult.reputationAwarded,
            newReputationTotal: pointsResult.newReputationTotal,
          }
        : null,
    });
  },
);
