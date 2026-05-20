/**
 * Game Onboarding Service
 *
 * Manages the game tutorial flow for new users.
 * Tracks progress through onboarding steps and awards points.
 */

import {
  and,
  db,
  eq,
  type GameOnboardingRow,
  type GameOnboardingState,
  type GameOnboardingStep,
  gameOnboarding,
} from "@feed/db";
import {
  generateSnowflakeId,
  getNextOnboardingStep,
  logger,
  ONBOARDING_STEP_ORDER,
  ONBOARDING_STEP_POINTS,
} from "@feed/shared";
import { formatError } from "../utils/error-utils";
import { EarnedPointsService } from "./earned-points-service";

/**
 * Type guard to validate that a value is a valid GameOnboardingState.
 * Checks for required properties and their types.
 */
function isGameOnboardingState(value: unknown): value is GameOnboardingState {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const obj = value as Record<string, unknown>;

  // Check top-level structure
  if (
    !Array.isArray(obj.completedSteps) ||
    typeof obj.currentStep !== "string" ||
    (obj.startedAt !== null && typeof obj.startedAt !== "string") ||
    (obj.completedAt !== null && typeof obj.completedAt !== "string") ||
    !Array.isArray(obj.rewards)
  ) {
    return false;
  }

  // Validate completedSteps elements are strings
  for (const step of obj.completedSteps) {
    if (typeof step !== "string") {
      return false;
    }
  }

  // Validate rewards elements have required shape
  for (const reward of obj.rewards) {
    if (
      reward === null ||
      typeof reward !== "object" ||
      typeof (reward as Record<string, unknown>).step !== "string" ||
      typeof (reward as Record<string, unknown>).points !== "number"
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Get a validated GameOnboardingState from a raw value, with fallback to safe defaults.
 */
function getValidatedState(
  rawState: unknown,
  userId: string,
): GameOnboardingState {
  if (isGameOnboardingState(rawState)) {
    return rawState;
  }

  // Log warning for malformed state
  logger.warn(
    "Malformed or null onboarding state, using defaults",
    { userId, rawState: typeof rawState },
    "GameOnboarding",
  );

  // Return safe default state
  return {
    completedSteps: [],
    currentStep: "welcome",
    startedAt: null,
    completedAt: null,
    rewards: [],
  };
}

/**
 * Create or get onboarding record for a user.
 * Uses INSERT ... ON CONFLICT DO NOTHING then SELECT for atomic, race-free creation.
 */
export async function getOrCreateOnboarding(
  userId: string,
): Promise<GameOnboardingRow> {
  const id = await generateSnowflakeId();
  const now = new Date();
  const initialState: GameOnboardingState = {
    completedSteps: [],
    currentStep: "welcome",
    startedAt: now.toISOString(),
    completedAt: null,
    rewards: [],
  };

  // Attempt insert, do nothing on conflict (userId is unique)
  // Use RETURNING to detect if the insert actually happened
  const insertResult = await db
    .insert(gameOnboarding)
    .values({
      id,
      userId,
      currentStep: "welcome",
      state: initialState,
      isComplete: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: gameOnboarding.userId })
    .returning({ insertedId: gameOnboarding.id });

  // If insert returned a row, it was newly created
  const wasCreated = insertResult.length > 0;

  // Select the row (either just created or already existed)
  const [row] = await db
    .select()
    .from(gameOnboarding)
    .where(eq(gameOnboarding.userId, userId))
    .limit(1);

  if (!row) {
    // This should never happen, but handle gracefully
    throw new Error(`Failed to get or create onboarding for user ${userId}`);
  }

  // Log only if this was a new creation (based on insert result, not timestamp comparison)
  if (wasCreated) {
    logger.info(
      `Created game onboarding for user ${userId}`,
      { userId, onboardingId: row.id },
      "GameOnboarding",
    );
  }

  return row;
}

/** Maximum retry attempts for optimistic locking */
const MAX_OPTIMISTIC_LOCK_RETRIES = 3;

/**
 * Complete an onboarding step and award reputation.
 * Uses optimistic locking to prevent race conditions from awarding duplicate reputation.
 */
export async function completeOnboardingStep(
  userId: string,
  step: GameOnboardingStep,
  retryCount = 0,
): Promise<{
  success: boolean;
  reputationAwarded: number;
  nextStep: GameOnboardingStep;
  isComplete: boolean;
}> {
  const onboarding = await getOrCreateOnboarding(userId);
  const state = getValidatedState(onboarding.state, userId);

  // Check if already completed
  if (state.completedSteps.includes(step)) {
    return {
      success: false,
      reputationAwarded: 0,
      nextStep: state.currentStep,
      isComplete: onboarding.isComplete,
    };
  }

  // Award points
  const points = ONBOARDING_STEP_POINTS[step];

  // Update state
  state.completedSteps.push(step);
  state.currentStep = getNextOnboardingStep(step);
  state.rewards.push({ step, points });

  const isComplete = state.currentStep === "complete";
  if (isComplete) {
    state.completedAt = new Date().toISOString();
  }

  // Update database with optimistic lock check on updatedAt
  // This prevents race conditions where concurrent requests both pass the
  // already-completed check before either writes to the database
  const result = await db
    .update(gameOnboarding)
    .set({
      currentStep: state.currentStep,
      state,
      isComplete,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(gameOnboarding.userId, userId),
        eq(gameOnboarding.updatedAt, onboarding.updatedAt),
      ),
    )
    .returning();

  // If no rows updated, someone else modified it - retry with fresh data
  if (!result || result.length === 0) {
    if (retryCount >= MAX_OPTIMISTIC_LOCK_RETRIES) {
      logger.warn(
        `Optimistic lock retry limit reached for onboarding step completion`,
        { userId, step, retryCount },
        "GameOnboarding",
      );
      // Return the original persisted value, not the mutated state
      return {
        success: false,
        reputationAwarded: 0,
        nextStep: onboarding.currentStep,
        isComplete: onboarding.isComplete,
      };
    }

    // Exponential backoff with jitter to avoid thundering herd
    const baseDelayMs = 50;
    const maxDelayMs = 1000;
    const exponentialDelay = baseDelayMs * 2 ** retryCount;
    const jitter = Math.random() * exponentialDelay * 0.3; // Up to 30% jitter
    const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

    logger.debug(
      `Optimistic lock conflict, retrying onboarding step completion`,
      { userId, step, retryCount: retryCount + 1, delayMs: Math.round(delay) },
      "GameOnboarding",
    );

    await new Promise((resolve) => setTimeout(resolve, delay));
    return completeOnboardingStep(userId, step, retryCount + 1);
  }

  logger.info(
    `User ${userId} completed onboarding step ${step}`,
    { userId, step, points, nextStep: state.currentStep, isComplete },
    "GameOnboarding",
  );

  // Award bonus points to user balance with retry on transient failures
  if (points > 0) {
    const maxPointsRetries = 3;
    const baseDelayMs = 100;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxPointsRetries; attempt++) {
      try {
        await EarnedPointsService.awardBonusPoints(
          userId,
          points,
          `onboarding_${step}`,
        );
        lastError = null;
        break; // Success - exit retry loop
      } catch (error) {
        lastError = error;
        const isLastAttempt = attempt >= maxPointsRetries - 1;
        if (!isLastAttempt) {
          // Exponential backoff with jitter
          const delay = baseDelayMs * 2 ** attempt * (0.5 + Math.random());
          logger.debug(
            `Retrying bonus points award after failure`,
            {
              userId,
              step,
              points,
              attempt: attempt + 1,
              delayMs: Math.round(delay),
            },
            "GameOnboarding",
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError) {
      // All retries exhausted - log for manual reconciliation
      // TODO: Consider adding a persistent retry queue (e.g., DB-backed job table)
      // to ensure points are eventually awarded even after process restart
      logger.warn(
        `Failed to award bonus points for onboarding step after ${maxPointsRetries} attempts - manual reconciliation needed`,
        {
          userId,
          step,
          points,
          reason: `onboarding_${step}`,
          error: formatError(lastError),
          failedAt: new Date().toISOString(),
          retriesAttempted: maxPointsRetries,
        },
        "GameOnboarding",
      );
    }
  }

  return {
    success: true,
    reputationAwarded: points,
    nextStep: state.currentStep,
    isComplete,
  };
}

/**
 * Get onboarding status for a user.
 * Returns null if no onboarding record exists (does not auto-create).
 */
export async function getOnboardingStatus(userId: string): Promise<{
  currentStep: GameOnboardingStep;
  completedSteps: GameOnboardingStep[];
  totalPointsEarned: number;
  isComplete: boolean;
} | null> {
  // Query directly without auto-creating - status check shouldn't have side effects
  const [onboarding] = await db
    .select()
    .from(gameOnboarding)
    .where(eq(gameOnboarding.userId, userId))
    .limit(1);

  if (!onboarding) {
    return null;
  }

  const state = getValidatedState(onboarding.state, userId);

  const totalPointsEarned = state.rewards.reduce((sum, r) => sum + r.points, 0);

  return {
    currentStep: state.currentStep,
    completedSteps: state.completedSteps,
    totalPointsEarned,
    isComplete: onboarding.isComplete,
  };
}

/**
 * Skip onboarding for a user.
 *
 * Note: This intentionally creates an onboarding record if none exists.
 * This tracks that the user was offered onboarding and explicitly declined,
 * which is useful for analytics and ensuring they aren't prompted again.
 */
export async function skipOnboarding(userId: string): Promise<void> {
  // Intentionally create record if needed - tracks that user declined onboarding
  const onboarding = await getOrCreateOnboarding(userId);

  await db
    .update(gameOnboarding)
    .set({
      isComplete: true,
      skippedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(gameOnboarding.userId, userId));

  logger.info(
    `User ${userId} skipped onboarding`,
    { userId, onboardingId: onboarding.id },
    "GameOnboarding",
  );
}

/**
 * Check if a user needs onboarding
 */
export async function needsOnboarding(userId: string): Promise<boolean> {
  const [onboarding] = await db
    .select({
      isComplete: gameOnboarding.isComplete,
      skippedAt: gameOnboarding.skippedAt,
    })
    .from(gameOnboarding)
    .where(eq(gameOnboarding.userId, userId))
    .limit(1);

  if (!onboarding) {
    return true; // No record = needs onboarding
  }

  return !onboarding.isComplete && !onboarding.skippedAt;
}

/**
 * Get the step order for onboarding.
 * Useful for UI components that need to display progress.
 */
export function getOnboardingStepOrder(): GameOnboardingStep[] {
  return [...ONBOARDING_STEP_ORDER];
}

/**
 * Get the points awarded for each onboarding step.
 * Useful for displaying potential rewards in the UI.
 */
export function getOnboardingStepPoints(): Record<GameOnboardingStep, number> {
  return { ...ONBOARDING_STEP_POINTS };
}
