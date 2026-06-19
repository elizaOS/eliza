/**
 * Game Onboarding Complete Step API
 *
 * @route POST /api/onboarding/game-complete-step - Complete an onboarding step
 * @access Private (authenticated users only)
 *
 * @description
 * Marks an onboarding step as complete for the authenticated user.
 * Awards reputation for the completed step.
 */

import { authenticate, successResponse, withErrorHandling } from "@feed/api";
import { completeOnboardingStep } from "@feed/engine";
import { type GameOnboardingStep, ONBOARDING_STEP_ORDER } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

/**
 * Valid onboarding steps for validation.
 * Uses the canonical ONBOARDING_STEP_ORDER but filters out 'complete'
 * since that is a terminal state, not a completable step.
 */
const completableSteps = ONBOARDING_STEP_ORDER.filter(
  (step) => step !== "complete",
) as [GameOnboardingStep, ...GameOnboardingStep[]];
const GameOnboardingStepSchema = z.enum(completableSteps);

const CompleteStepRequestSchema = z.object({
  step: GameOnboardingStepSchema,
});

/**
 * POST /api/onboarding/game-complete-step
 *
 * Completes an onboarding step for the authenticated user.
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  const body = await request.json();
  const { step } = CompleteStepRequestSchema.parse(body);

  const result = await completeOnboardingStep(user.userId, step);

  return successResponse({
    reputationAwarded: result.reputationAwarded,
    nextStep: result.nextStep,
    isComplete: result.isComplete,
  });
});
