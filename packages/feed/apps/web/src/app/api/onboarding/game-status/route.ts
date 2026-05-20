/**
 * Game Onboarding Status API
 *
 * @route GET /api/onboarding/game-status - Get game onboarding status
 * @access Private (authenticated users only)
 *
 * @description
 * Returns the current game tutorial onboarding status for the authenticated user.
 */

import { authenticate, successResponse, withErrorHandling } from '@babylon/api';
import { getOrCreateOnboarding } from '@babylon/engine';
import type { NextRequest } from 'next/server';

/**
 * Type guard for reward validation.
 * Validates that a reward object has a numeric points field.
 */
function isValidReward(r: unknown): r is { points: number } {
  return (
    r !== null &&
    typeof r === 'object' &&
    'points' in r &&
    typeof (r as { points: unknown }).points === 'number' &&
    !isNaN((r as { points: number }).points)
  );
}

/**
 * GET /api/onboarding/game-status
 *
 * Returns current game onboarding status for the authenticated user.
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  const onboarding = await getOrCreateOnboarding(user.userId);
  const state = onboarding.state;

  // Calculate total reputation earned, defensively validating each reward item.
  const totalReputationEarned =
    state?.rewards?.reduce(
      (sum: number, r: unknown) => (isValidReward(r) ? sum + r.points : sum),
      0
    ) ?? 0;

  return successResponse({
    currentStep: onboarding.currentStep,
    completedSteps: state?.completedSteps ?? [],
    totalReputationEarned,
    isComplete: onboarding.isComplete,
  });
});
