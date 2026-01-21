/**
 * User Is New API
 *
 * @route GET /api/users/[userId]/is-new - Check if user is new
 * @access Public (optional authentication)
 *
 * @description
 * Checks if a user needs profile setup. Returns whether user is new and
 * needs onboarding. Optional authentication for personalized results.
 *
 * @openapi
 * /api/users/{userId}/is-new:
 *   get:
 *     tags:
 *       - Users
 *     summary: Check if user is new
 *     description: Returns whether user needs profile setup (optional auth)
 *     security:
 *       - PrivyAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: Status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 needsSetup:
 *                   type: boolean
 *                 isNew:
 *                   type: boolean
 *       401:
 *         description: Unauthorized (optional)
 *
 * @example
 * ```typescript
 * const { needsSetup } = await fetch(`/api/users/${userId}/is-new`)
 *   .then(r => r.json());
 * ```
 */

import {
  AuthorizationError,
  authenticate,
  findUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import { logger, UserIdParamSchema } from "@polyagent/shared";
import type { NextRequest } from "next/server";

/**
 * GET /api/users/[userId]/is-new
 * Check if user needs profile setup
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    // Optional authentication - if not authenticated, return needsSetup: false
    const authUser = await authenticate(request).catch(() => null);
    const params = await context.params;
    const { userId } = UserIdParamSchema.parse(params);

    if (!authUser) {
      logger.info(
        "Unauthenticated user checking is-new status",
        {},
        "GET /api/users/[userId]/is-new",
      );
      return successResponse({ needsSetup: false });
    }

    // Check if user exists and needs setup
    const dbUser = await findUserByIdentifier(userId, {
      id: true,
      username: true,
      displayName: true,
      bio: true,
      profileImageUrl: true,
      profileComplete: true,
      hasUsername: true,
      hasBio: true,
      hasProfileImage: true,
    });

    const canonicalUserId = dbUser?.id ?? userId;

    // Ensure requesting user matches the target user
    if (authUser.userId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only check your own setup status",
        "user-setup",
        "read",
      );
    }

    if (!dbUser) {
      // User doesn't exist yet - needs setup
      logger.info(
        "User not found, needs setup",
        { userId: canonicalUserId },
        "GET /api/users/[userId]/is-new",
      );
      return successResponse({ needsSetup: true });
    }

    // Check if profile is complete
    // User needs setup if they don't have username, displayName, or bio
    const needsSetup =
      !dbUser.profileComplete &&
      (!dbUser.username ||
        !dbUser.displayName ||
        !dbUser.hasUsername ||
        !dbUser.hasBio);

    logger.info(
      "User setup status checked",
      { userId: canonicalUserId, needsSetup },
      "GET /api/users/[userId]/is-new",
    );

    return successResponse({
      needsSetup,
      profileComplete: dbUser.profileComplete || false,
      hasUsername: dbUser.hasUsername || false,
      hasBio: dbUser.hasBio || false,
      hasProfileImage: dbUser.hasProfileImage || false,
    });
  },
);
