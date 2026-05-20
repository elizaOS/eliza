/**
 * Achievements API
 *
 * @route GET /api/achievements
 * @access Authenticated users
 * @description Returns all 15 achievements with user's progress and unlock status
 */

import {
  authenticateWithDbUser,
  getUserAchievements,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { dbUserId } = await authenticateWithDbUser(request);
  const achievements = await getUserAchievements(dbUserId);
  return successResponse({ achievements });
});
