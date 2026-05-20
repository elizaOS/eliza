/**
 * User Profile Update API
 *
 * @route POST /api/users/[userId]/update-profile - Update user profile
 * @access Authenticated (own profile only)
 *
 * @description
 * Updates user profile information including username, display name, bio, images,
 * and social media visibility settings. Includes rate limiting, on-chain profile
 * updates, reputation awards for profile completion, and backend signing support.
 *
 * @openapi
 * /api/users/{userId}/update-profile:
 *   post:
 *     tags:
 *       - Users
 *     summary: Update user profile
 *     description: Updates user profile with rate limiting and on-chain support
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID (must match authenticated user)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               displayName:
 *                 type: string
 *               bio:
 *                 type: string
 *               profileImageUrl:
 *                 type: string
 *               coverImageUrl:
 *                 type: string
 *               showTwitterPublic:
 *                 type: boolean
 *               showFarcasterPublic:
 *                 type: boolean
 *               showWalletPublic:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                 message:
 *                   type: string
 *                 reputationRewards:
 *                   type: array
 *       400:
 *         description: Username taken or rate limit exceeded
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Cannot update another user's profile
 *
 * @example
 * ```typescript
 * await fetch(`/api/users/${userId}/update-profile`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     displayName: 'New Name',
 *     bio: 'Updated bio',
 *     profileImageUrl: 'https://...'
 *   })
 * });
 * ```
 *
 */

import {
  AuthorizationError,
  authenticate,
  BusinessLogicError,
  cachedDb,
  checkProfileUpdateRateLimit,
  isReferralCodeAvailableForUser,
  logProfileUpdate,
  notifyProfileComplete,
  ReputationService,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { and, db, eq, ne, sql, users } from "@feed/db";
import { logger, UpdateUserSchema, UserIdParamSchema } from "@feed/shared";
import type { NextRequest } from "next/server";
import { trackServerEvent } from "@/lib/posthog/server";

/**
 * POST /api/users/[userId]/update-profile
 * Update user profile information
 */
/**
 * POST /api/users/[userId]/update-profile
 *
 * Updates user profile information including username, display name, bio, images, and social
 * media visibility settings. Includes rate limiting, username uniqueness validation, on-chain
 * profile updates (optional), reputation awards for profile completion, and backend signing support.
 * Only the profile owner can update their own profile.
 *
 * @param request - Next.js request containing profile update fields
 * @param context - Route context with user ID parameter (must match authenticated user)
 * @returns Updated user object with reputation rewards and on-chain transaction info
 * @throws {400} Username taken, rate limit exceeded, or invalid input
 * @throws {401} Unauthorized
 * @throws {403} Cannot update another user's profile
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

    // Ensure user can only update their own profile
    if (authUser.userId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only update your own profile",
        "profile",
        "update",
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const parsedBody = UpdateUserSchema.parse(body);
    const {
      username,
      displayName,
      bio,
      profileImageUrl,
      coverImageUrl,
      showTwitterPublic,
      showFarcasterPublic,
      showWalletPublic,
    } = parsedBody;

    // Check username uniqueness only if username is being updated (case-insensitive)
    if (username !== undefined) {
      const normalizedUsername = username.trim();
      const [existingUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            sql`lower(${users.username}) = lower(${normalizedUsername})`,
            ne(users.id, canonicalUserId),
          ),
        )
        .limit(1);

      if (existingUser) {
        throw new BusinessLogicError(
          "Username is already taken",
          "USERNAME_TAKEN",
        );
      }
    }

    const [currentUser] = await db
      .select({
        username: users.username,
        displayName: users.displayName,
        bio: users.bio,
        profileImageUrl: users.profileImageUrl,
        coverImageUrl: users.coverImageUrl,
        hasUsername: users.hasUsername,
        hasBio: users.hasBio,
        hasProfileImage: users.hasProfileImage,
        usernameChangedAt: users.usernameChangedAt,
        pointsAwardedForProfile: users.pointsAwardedForProfile,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    const normalizedUsername =
      username !== undefined ? username.trim() : undefined;
    const normalizedDisplayName =
      displayName !== undefined ? displayName.trim() : undefined;
    const normalizedBio = bio !== undefined ? bio.trim() : undefined;
    const normalizedProfileImageUrl =
      profileImageUrl !== undefined ? profileImageUrl.trim() : undefined;
    const normalizedCoverImageUrl =
      coverImageUrl !== undefined ? coverImageUrl.trim() : undefined;

    const isUsernameChanging =
      normalizedUsername !== undefined &&
      normalizedUsername !== (currentUser?.username ?? "");

    await checkProfileUpdateRateLimit(canonicalUserId, isUsernameChanging);

    // On-chain sync is handled by a separate background job.
    // Profile updates are now database-first - we save to DB immediately
    // and the chain sync job will update on-chain state later.
    //

    // Update referral code if username is changing and username is available
    const referralCodeUpdate: { referralCode?: string } = {};
    if (isUsernameChanging && normalizedUsername) {
      const isReferralCodeAvailable = await isReferralCodeAvailableForUser(
        canonicalUserId,
        normalizedUsername,
      );

      if (isReferralCodeAvailable) {
        referralCodeUpdate.referralCode = normalizedUsername;
      }
    }

    const updateData: Partial<typeof users.$inferInsert> = {
      ...(normalizedUsername !== undefined && {
        username: normalizedUsername || null,
      }),
      ...(normalizedDisplayName !== undefined && {
        displayName: normalizedDisplayName || null,
      }),
      ...(normalizedBio !== undefined && { bio: normalizedBio || null }),
      ...(normalizedProfileImageUrl !== undefined && {
        profileImageUrl: normalizedProfileImageUrl || null,
      }),
      ...(normalizedCoverImageUrl !== undefined && {
        coverImageUrl: normalizedCoverImageUrl || null,
      }),
      ...(showTwitterPublic !== undefined && { showTwitterPublic }),
      ...(showFarcasterPublic !== undefined && { showFarcasterPublic }),
      ...(showWalletPublic !== undefined && { showWalletPublic }),
      ...(isUsernameChanging && { usernameChangedAt: new Date() }),
      ...referralCodeUpdate,
      hasUsername:
        normalizedUsername !== undefined
          ? normalizedUsername.length > 0
          : undefined,
      hasBio:
        normalizedBio !== undefined ? normalizedBio.length > 0 : undefined,
      hasProfileImage:
        normalizedProfileImageUrl !== undefined
          ? normalizedProfileImageUrl.length > 0
          : undefined,
      profileComplete:
        normalizedUsername !== undefined &&
        normalizedDisplayName !== undefined &&
        normalizedBio !== undefined &&
        normalizedProfileImageUrl !== undefined
          ? normalizedUsername.length > 0 &&
            normalizedDisplayName.length > 0 &&
            normalizedBio.length > 0 &&
            normalizedProfileImageUrl.length > 0
          : undefined,
    };

    const [updatedUser] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, canonicalUserId))
      .returning({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        bio: users.bio,
        profileImageUrl: users.profileImageUrl,
        coverImageUrl: users.coverImageUrl,
        profileComplete: users.profileComplete,
        hasUsername: users.hasUsername,
        hasBio: users.hasBio,
        hasProfileImage: users.hasProfileImage,
        reputationPoints: users.reputationPoints,
        referralCount: users.referralCount,
        referralCode: users.referralCode,
        usernameChangedAt: users.usernameChangedAt,
        privyId: users.privyId,
      });

    // Refresh identifier caches after any profile update because these caches now
    // store full user rows, not just identifiers.
    if (updatedUser) {
      await cachedDb.invalidateUserIdentifierCaches(
        {
          id: updatedUser.id,
          privyId: updatedUser.privyId,
          username: updatedUser.username,
        },
        {
          username: isUsernameChanging ? currentUser?.username : undefined,
        },
      );
    }

    // Award reputation for profile milestones.
    const reputationRewards: { reason: string; amount: number }[] = [];

    if (!currentUser?.pointsAwardedForProfile && updatedUser) {
      const hasUsername =
        updatedUser.username && updatedUser.username.trim().length > 0;
      const hasImage =
        updatedUser.profileImageUrl &&
        updatedUser.profileImageUrl.trim().length > 0;
      const hasBio = updatedUser.bio && updatedUser.bio.trim().length >= 50;

      if (hasUsername && hasImage && hasBio) {
        const result =
          await ReputationService.awardProfileCompletion(canonicalUserId);
        if (result.success && result.reputationAwarded > 0) {
          reputationRewards.push({
            reason: "profile_completion",
            amount: result.reputationAwarded,
          });
          logger.info(
            `Awarded ${result.reputationAwarded} reputation to user ${canonicalUserId} for completing profile (username + image + bio)`,
            { userId: canonicalUserId, reputation: result.reputationAwarded },
            "POST /api/users/[userId]/update-profile",
          );

          await notifyProfileComplete(
            canonicalUserId,
            result.reputationAwarded,
          );
          logger.info(
            "Profile completion notification sent",
            { userId: canonicalUserId },
            "POST /api/users/[userId]/update-profile",
          );

          // Award referral qualification bonus to referrer if user was referred
          const referralQualificationResult =
            await ReputationService.checkAndQualifyReferral(
              canonicalUserId,
            ).catch((error) => {
              // Log error but don't fail the request if qualification check fails
              logger.warn(
                `Failed to check and qualify referral for user ${canonicalUserId}`,
                { userId: canonicalUserId, error },
                "POST /api/users/[userId]/update-profile",
              );
              return null;
            });
          if (referralQualificationResult?.success) {
            logger.info(
              `Awarded ${referralQualificationResult.reputationAwarded} referral qualification reputation to referrer`,
              {
                referredUserId: canonicalUserId,
                reputation: referralQualificationResult.reputationAwarded,
              },
              "POST /api/users/[userId]/update-profile",
            );
          }
        }
      }
    }

    if (reputationRewards.length > 0) {
      logger.info(
        `Awarded reputation for profile updates: ${reputationRewards.map((reward) => `${reward.reason}(+${reward.amount})`).join(", ")}`,
        { userId: canonicalUserId, reputationRewards },
        "POST /api/users/[userId]/update-profile",
      );
    }

    // Log the profile update for rate limiting and auditing
    const fieldsUpdated = Object.keys(parsedBody).filter(
      (key) => parsedBody[key as keyof typeof parsedBody] !== undefined,
    );
    await logProfileUpdate(canonicalUserId, fieldsUpdated, false);

    logger.info(
      "Profile updated successfully",
      {
        userId: canonicalUserId,
        reputationRewardsCount: reputationRewards.length,
      },
      "POST /api/users/[userId]/update-profile",
    );

    // Track profile updated event
    trackServerEvent(canonicalUserId, "profile_updated", {
      fieldsUpdated,
      hasNewProfileImage:
        normalizedProfileImageUrl !== undefined &&
        normalizedProfileImageUrl !== currentUser?.profileImageUrl,
      hasNewCoverImage:
        normalizedCoverImageUrl !== undefined &&
        normalizedCoverImageUrl !== currentUser?.coverImageUrl,
      hasNewBio:
        normalizedBio !== undefined && normalizedBio !== currentUser?.bio,
      usernameChanged: isUsernameChanging,
      profileComplete: updatedUser?.profileComplete ?? false,
      reputationAwarded: reputationRewards.reduce(
        (sum, reward) => sum + reward.amount,
        0,
      ),
    }).catch((error) => {
      logger.warn("Failed to track profile_updated event", { error });
    });

    return successResponse({
      user: updatedUser,
      message: "Profile updated successfully",
      reputationAwarded: reputationRewards.reduce(
        (sum, reward) => sum + reward.amount,
        0,
      ),
      reputationRewards,
    });
  },
);
