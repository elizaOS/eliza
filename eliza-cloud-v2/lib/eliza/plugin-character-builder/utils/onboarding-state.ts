/**
 * Onboarding State Utilities
 *
 * Simple per-user tracking: has this user been onboarded?
 * Tracked by entityId - once onboarded, GUIDE_ONBOARDING is disabled.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

interface OnboardingState {
  completed: boolean;
  completedAt: number;
}

function onboardingKey(entityId: string): string {
  return `onboarding:${entityId}`;
}

/**
 * Check if user has been onboarded
 */
export async function isOnboarded(
  runtime: IAgentRuntime,
  entityId: string,
): Promise<boolean> {
  const key = onboardingKey(entityId);
  const state = await runtime.getCache<OnboardingState>(key);
  return state?.completed === true;
}

/**
 * Mark user as onboarded (disables GUIDE_ONBOARDING for this user)
 */
export async function markOnboarded(
  runtime: IAgentRuntime,
  entityId: string,
): Promise<void> {
  const key = onboardingKey(entityId);
  const state: OnboardingState = {
    completed: true,
    completedAt: Date.now(),
  };
  await runtime.setCache(key, state);
  logger.info(`[Onboarding] User ${entityId} onboarded`);
}
