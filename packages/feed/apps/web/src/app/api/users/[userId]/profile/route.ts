/**
 * User Profile API Route
 *
 * @description Retrieves comprehensive user profile information including stats, social connections, and account details
 *
 * @route GET /api/users/[userId]/profile
 * @access Public (no authentication required)
 *
 * @openapi
 * /api/users/{userId}/profile:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get user profile
 *     description: Retrieves comprehensive profile information for a specific user including stats, social connections, and account details
 *     operationId: getUserProfile
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID, username, or wallet address
 *         example: "user_123abc"
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Unique user identifier
 *                     username:
 *                       type: string
 *                       description: Username
 *                     displayName:
 *                       type: string
 *                       description: Display name
 *                     bio:
 *                       type: string
 *                       nullable: true
 *                       description: User biography
 *                     profileImageUrl:
 *                       type: string
 *                       nullable: true
 *                       description: Profile image URL
 *                     coverImageUrl:
 *                       type: string
 *                       nullable: true
 *                       description: Cover image URL
 *                     walletAddress:
 *                       type: string
 *                       nullable: true
 *                       description: Blockchain wallet address
 *                     virtualBalance:
 *                       type: number
 *                       description: Virtual balance in game currency
 *                     lifetimePnL:
 *                       type: number
 *                       description: Lifetime profit and loss
 *                     reputationPoints:
 *                       type: integer
 *                       description: Reputation points earned
 *                     isActor:
 *                       type: boolean
 *                       description: Whether this is an NPC actor
 *                     profileComplete:
 *                       type: boolean
 *                       description: Whether profile setup is complete
 *                     hasFarcaster:
 *                       type: boolean
 *                       description: Whether Farcaster is linked
 *                     hasTwitter:
 *                       type: boolean
 *                       description: Whether Twitter is linked
 *                     stats:
 *                       type: object
 *                       description: User statistics
 *                       properties:
 *                         positions:
 *                           type: integer
 *                           description: Number of open positions
 *                         comments:
 *                           type: integer
 *                           description: Total comments made
 *                         reactions:
 *                           type: integer
 *                           description: Total reactions given
 *                         followers:
 *                           type: integer
 *                           description: Number of followers
 *                         following:
 *                           type: integer
 *                           description: Number of users/actors following
 *                         posts:
 *                           type: integer
 *                           description: Total posts created
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

import {
  addPublicReadHeaders,
  findUserByIdentifier,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { logger, toISO, toISOOrNull, UserIdParamSchema } from "@feed/shared";
import type { NextRequest } from "next/server";
import { sanitizeForJson } from "@/lib/json/sanitize";
import { getOptionalProfileStats } from "@/lib/users/profile-stats";

/**
 * GET Handler for User Profile
 *
 * @description Retrieves comprehensive user profile information including stats and social connections
 *
 * @param {NextRequest} request - Next.js request object
 * @param {Object} context - Route context containing dynamic parameters
 * @param {Promise<{userId: string}>} context.params - Dynamic route parameters
 *
 * @returns {Promise<NextResponse>} User profile data with stats
 *
 * @throws {NotFoundError} When user is not found
 * @throws {ValidationError} When userId parameter is invalid
 *
 * @example
 * ```typescript
 * // Request
 * GET /api/users/johndoe/profile
 *
 * // Response
 * {
 *   "user": {
 *     "id": "user_123",
 *     "username": "johndoe",
 *     "displayName": "John Doe",
 *     "virtualBalance": 10000,
 *     "stats": {
 *       "followers": 150,
 *       "following": 75,
 *       "posts": 42
 *     }
 *   }
 * }
 * ```
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    const { error, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    const params = await context.params;
    const { userId } = UserIdParamSchema.parse(params);

    // findUserByIdentifier returns a fully-typed User and shares the same cache as
    // findUserByIdentifierWithSelect (both use classification-based routing + Redis cache).
    const dbUser = await findUserByIdentifier(userId);

    // If user doesn't exist, findUserByIdentifierWithSelect returns null for non-existent users
    // WHY return { user: null } instead of throwing NotFoundError?
    // - This route is public (no auth required) and handles new users gracefully
    // - New users may authenticate before completing signup, so they won't exist in DB yet
    // - Returning null allows frontend to handle "user not found" vs "user needs onboarding" states
    if (!dbUser) {
      logger.info(
        "User not found - new Steward user who hasn't completed signup",
        { userId },
        "GET /api/users/[userId]/profile",
      );
      return successResponse(
        sanitizeForJson({
          user: null,
        }),
      );
    }

    // Get cached profile stats (followers, following, posts, etc.)
    const stats = await getOptionalProfileStats(
      dbUser.id,
      "GET /api/users/[userId]/profile",
    );

    logger.info(
      "User profile fetched successfully",
      { userId, statsAvailable: Boolean(stats) },
      "GET /api/users/[userId]/profile",
    );

    const res = successResponse(
      sanitizeForJson({
        user: {
          id: dbUser.id,
          walletAddress: dbUser.walletAddress,
          username: dbUser.username,
          displayName: dbUser.displayName,
          bio: dbUser.bio,
          profileImageUrl: dbUser.profileImageUrl,
          coverImageUrl: dbUser.coverImageUrl,
          isActor: dbUser.isActor,
          isAgent: dbUser.isAgent,
          managedBy: dbUser.managedBy,
          profileComplete: dbUser.profileComplete,
          hasUsername: dbUser.hasUsername,
          hasBio: dbUser.hasBio,
          hasProfileImage: dbUser.hasProfileImage,
          nftTokenId: dbUser.nftTokenId,
          virtualBalance: Number(dbUser.virtualBalance ?? 0),
          lifetimePnL: Number(dbUser.lifetimePnL ?? 0),
          reputationPoints: dbUser.reputationPoints,
          earnedPoints: dbUser.earnedPoints,
          invitePoints: dbUser.invitePoints,
          bonusPoints: dbUser.bonusPoints,
          referralCount: dbUser.referralCount,
          referralCode: dbUser.referralCode,
          hasFarcaster: dbUser.hasFarcaster,
          hasTwitter: dbUser.hasTwitter,
          farcasterUsername: dbUser.farcasterUsername,
          twitterUsername: dbUser.twitterUsername,
          usernameChangedAt: toISOOrNull(dbUser.usernameChangedAt),
          createdAt: toISO(dbUser.createdAt),
          stats,
        },
      }),
    );
    if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
    return res;
  },
);
