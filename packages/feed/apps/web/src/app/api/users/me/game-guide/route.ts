// POST /api/users/me/game-guide - Mark game guide as completed

import { authenticate, successResponse, withErrorHandling } from "@feed/api";
import { db, eq, users } from "@feed/db";
import { logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const now = new Date();

  const result = await db
    .update(users)
    .set({ gameGuideCompletedAt: now, updatedAt: now })
    .where(eq(users.privyId, authUser.privyId!))
    .returning({ id: users.id });

  if (result.length === 0) {
    logger.warn(
      "Game guide: no user found",
      { privyId: authUser.privyId },
      "game-guide",
    );
  }

  return successResponse({
    success: true,
    gameGuideCompletedAt: toISO(now),
  });
});
