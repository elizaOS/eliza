/**
 * User Points History API
 *
 * @route GET /api/users/[userId]/points-history - Get user's points transaction history
 * @access Authenticated
 *
 * @description
 * Returns the user's points transactions history (limited to recent transactions).
 * Used to check which rewards have already been claimed.
 */

import {
  AuthorizationError,
  authenticate,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import { db, desc, eq, pointsTransactions } from "@polyagent/db";
import { UserIdParamSchema } from "@polyagent/shared";
import type { NextRequest } from "next/server";

/**
 * GET /api/users/[userId]/points-history
 * Get user's points transaction history
 */
export const GET = withErrorHandling(
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
        "points-history",
        "read",
      );
    }

    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    // Verify user is getting their own history
    if (authUser.dbUserId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only view your own points history",
        "points-history",
        "read",
      );
    }

    // Get recent transactions (last 100)
    const transactions = await db
      .select()
      .from(pointsTransactions)
      .where(eq(pointsTransactions.userId, canonicalUserId))
      .orderBy(desc(pointsTransactions.createdAt))
      .limit(100);

    return successResponse({
      transactions,
    });
  },
);
