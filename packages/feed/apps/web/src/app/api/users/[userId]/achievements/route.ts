/**
 * User Achievements API
 *
 * @route GET /api/users/[userId]/achievements
 * @access Public (no authentication required)
 * @description Returns a user's recently unlocked achievements for profile display
 */

import {
  getRecentAchievements,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ userId: string }> }
  ) => {
    const { userId } = await params;
    const achievements = await getRecentAchievements(userId);
    return successResponse({ achievements });
  }
);
