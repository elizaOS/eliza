/**
 * Challenges API
 *
 * @route GET /api/challenges
 * @access Authenticated users
 * @description Returns active daily (3) and weekly (2) challenges with progress
 */

import {
  authenticateWithDbUser,
  getUserChallenges,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { dbUserId } = await authenticateWithDbUser(request);
  const challenges = await getUserChallenges(dbUserId);
  return successResponse(challenges);
});
