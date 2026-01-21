/**
 * Delete User API Key
 *
 * @route DELETE /api/users/api-keys/[keyId] - Revoke API key
 * @access Authenticated (own keys only)
 */

import {
  authenticate,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import { asUser, eq, userApiKeys } from "@polyagent/db";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * DELETE /api/users/api-keys/[keyId] - Revoke API key
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ keyId: string }> },
  ) => {
    const authUser = await authenticate(request);
    const { keyId } = await context.params;

    // Use asUser to enforce RLS - user can only revoke their own keys
    const deleted = await asUser(authUser.userId, async (dbClient) => {
      // First verify the key exists and belongs to the user (RLS enforces this)
      const key = await dbClient.query.userApiKeys.findFirst({
        where: (keys, { eq, and: andFn, isNull: isNullFn }) =>
          andFn(
            eq(keys.id, keyId),
            eq(keys.userId, authUser.userId),
            isNullFn(keys.revokedAt),
          ),
      });

      if (!key) {
        return null;
      }

      // Revoke the key by setting revokedAt
      return await dbClient
        .update(userApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(userApiKeys.id, keyId))
        .returning();
    });

    if (!deleted || deleted.length === 0) {
      return NextResponse.json(
        { error: "API key not found or already revoked" },
        { status: 404 },
      );
    }

    logger.info(
      "API key revoked",
      { userId: authUser.userId, keyId },
      "API Keys",
    );

    return successResponse({
      message: "API key revoked successfully",
    });
  },
);
