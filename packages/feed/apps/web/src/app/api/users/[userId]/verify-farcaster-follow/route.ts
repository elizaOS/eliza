/**
 * User Verify Farcaster Follow API
 *
 * @route POST /api/users/[userId]/verify-farcaster-follow - Verify Farcaster follow
 * @access Authenticated
 *
 * @description
 * Verifies that a user is following @playfeed on Farcaster.
 * Awards points if verification succeeds.
 *
 * @openapi
 * /api/users/{userId}/verify-farcaster-follow:
 *   post:
 *     tags:
 *       - Users
 *     summary: Verify Farcaster follow
 *     description: Verifies user is following @playfeed and awards points (authenticated user only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: Follow verified successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not authorized for this user
 *
 * @example
 * ```typescript
 * await fetch(`/api/users/${userId}/verify-farcaster-follow`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 * });
 * ```
 */

import {
  AuthorizationError,
  authenticate,
  BusinessLogicError,
  ReputationService,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { db, eq, users } from "@feed/db";
import { logger, UserIdParamSchema } from "@feed/shared";
import type { NextRequest } from "next/server";

// Feed Farcaster FID (playfeed)
const FEED_FARCASTER_FID = process.env.FARCASTER_FID || "1521916"; // playfeed FID

/**
 * POST /api/users/[userId]/verify-farcaster-follow
 * Verify that a user is following @playfeed on Farcaster
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
        "farcaster-follow-verification",
        "create",
      );
    }

    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    // Verify user is verifying their own follow
    if (authUser.dbUserId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only verify your own Farcaster follow",
        "farcaster-follow-verification",
        "create",
      );
    }

    // Get user's Farcaster info
    const [user] = await db
      .select({
        farcasterUsername: users.farcasterUsername,
        farcasterFid: users.farcasterFid,
        pointsAwardedForFarcasterFollow: users.pointsAwardedForFarcasterFollow,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    // VALIDATION 1: Check if user has linked Farcaster account
    if (!user?.farcasterUsername && !user?.farcasterFid) {
      throw new BusinessLogicError(
        "Please link your Farcaster account first to verify follow.",
        "FARCASTER_NOT_LINKED",
      );
    }

    const userFid = user.farcasterFid;

    if (!userFid) {
      throw new BusinessLogicError(
        "Farcaster FID not found. Please re-link your Farcaster account.",
        "FARCASTER_FID_NOT_FOUND",
      );
    }

    const alreadyAwarded = user.pointsAwardedForFarcasterFollow;

    // Check if Neynar API key is configured
    if (!process.env.NEYNAR_API_KEY) {
      throw new BusinessLogicError(
        "Farcaster verification is not configured. Please contact support.",
        "NEYNAR_NOT_CONFIGURED",
      );
    }

    // Verify follow using Neynar API
    let isFollowing = false;
    let verificationError: string | null = null;

    logger.info(
      "Attempting to verify Farcaster follow",
      { userId: canonicalUserId, userFid, feedFid: FEED_FARCASTER_FID },
      "POST /api/users/[userId]/verify-farcaster-follow",
    );

    // Use Neynar API to check relationship between user and Feed
    // Using viewer_fid to get viewer_context from Feed's perspective
    const neynarResponse = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${userFid}&viewer_fid=${FEED_FARCASTER_FID}`,
      {
        headers: {
          accept: "application/json",
          api_key: process.env.NEYNAR_API_KEY,
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      },
    );

    if (neynarResponse.ok) {
      const neynarData = await neynarResponse.json();

      logger.info(
        "Neynar API response received",
        { userId: canonicalUserId, hasUsers: !!neynarData.users },
        "POST /api/users/[userId]/verify-farcaster-follow",
      );

      if (neynarData.users && neynarData.users.length > 0) {
        const userData = neynarData.users[0];

        // Check viewer_context to see if user follows Feed
        // viewer_context is from Feed's perspective (viewer_fid=FEED_FARCASTER_FID):
        //   - followed_by: true = user follows Feed ✅ (this is what we want!)
        //   - following: true = Feed follows user (not what we want)
        const viewerContext = userData.viewer_context;

        if (viewerContext?.followed_by) {
          isFollowing = true;
          logger.info(
            "User is following @playfeed",
            { userId: canonicalUserId, userFid },
            "POST /api/users/[userId]/verify-farcaster-follow",
          );
        } else {
          verificationError =
            "You are not following @playfeed on Farcaster. Please follow first.";
          logger.warn(
            "User is not following @playfeed",
            { userId: canonicalUserId, userFid, viewerContext },
            "POST /api/users/[userId]/verify-farcaster-follow",
          );
        }
      } else {
        verificationError =
          "User not found on Farcaster. Please re-link your account.";
        logger.warn(
          "User not found in Neynar response",
          { userId: canonicalUserId, userFid },
          "POST /api/users/[userId]/verify-farcaster-follow",
        );
      }
    } else if (neynarResponse.status === 404) {
      verificationError =
        "User not found on Farcaster. Please check your account.";
      logger.warn(
        "User not found (404) via Neynar",
        { userId: canonicalUserId, userFid },
        "POST /api/users/[userId]/verify-farcaster-follow",
      );
    } else {
      const errorText = await neynarResponse.text().catch(() => "");
      verificationError = `Neynar API error (${neynarResponse.status}). Please try again later.`;
      logger.error(
        "Neynar API error",
        {
          userId: canonicalUserId,
          userFid,
          status: neynarResponse.status,
          error: errorText,
        },
        "POST /api/users/[userId]/verify-farcaster-follow",
      );
    }

    // If not following, return error
    if (!isFollowing) {
      return successResponse({
        verified: false,
        message:
          verificationError ||
          "Could not verify follow. Please ensure you are following @playfeed on Farcaster.",
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
      const reputationResult =
        await ReputationService.awardFarcasterFollow(canonicalUserId);

      if (reputationResult.success) {
        reputationAwarded = reputationResult.reputationAwarded;
        newReputationTotal = reputationResult.newReputationTotal;

        logger.info(
          `Awarded ${reputationAwarded} reputation for Farcaster follow`,
          { userId: canonicalUserId, reputationAwarded },
          "POST /api/users/[userId]/verify-farcaster-follow",
        );
      }
    } else {
      // Already awarded, but still successful verification
      logger.info(
        "Farcaster follow already verified (no additional points)",
        { userId: canonicalUserId },
        "POST /api/users/[userId]/verify-farcaster-follow",
      );
    }

    return successResponse({
      verified: true,
      message:
        reputationAwarded > 0
          ? `Follow verified successfully! You earned ${reputationAwarded} reputation.`
          : "Follow verified! You already received reputation for this action.",
      reputation: {
        awarded: reputationAwarded,
        newReputationTotal,
      },
    });
  },
);
