/**
 * Game Onboarding Skip API
 *
 * @route POST /api/onboarding/game-skip - Skip the onboarding tutorial
 * @access Private (authenticated users only)
 *
 * @description
 * Allows a user to skip the game onboarding tutorial.
 * Sets the onboarding as complete without awarding any points.
 */

import {
  authenticate,
  checkRateLimitAsync,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { getOnboardingStatus, skipOnboarding } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * POST /api/onboarding/game-skip
 *
 * Skips the onboarding tutorial for the authenticated user.
 *
 * @openapi
 * /api/onboarding/game-skip:
 *   post:
 *     summary: Skip the onboarding tutorial
 *     description: Marks the user's onboarding as complete without awarding points
 *     tags:
 *       - Onboarding
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Onboarding skipped successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 onboardingStatus:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     currentStep:
 *                       type: string
 *                     completedSteps:
 *                       type: array
 *                       items:
 *                         type: string
 *                     totalPointsEarned:
 *                       type: number
 *                     isComplete:
 *                       type: boolean
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *       500:
 *         description: Internal server error
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  // Rate limit: prevent abusive rapid calls to skip onboarding
  const rateLimit = await checkRateLimitAsync(
    user.userId,
    RATE_LIMIT_CONFIGS.UPDATE_PROFILE // 5 per minute - reasonable for profile-like updates
  );

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rateLimit.retryAfter },
      { status: 429 }
    );
  }

  await skipOnboarding(user.userId);

  logger.info(
    `User skipped onboarding`,
    { userId: user.userId },
    'GameOnboarding'
  );

  const onboardingStatus = await getOnboardingStatus(user.userId);

  return successResponse({ success: true, onboardingStatus });
});
