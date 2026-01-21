/**
 * Feedback Service
 *
 * Provides domain logic for feedback submission and scoring.
 * This keeps the API route thin and the business logic portable.
 */

import { db, type JsonValue } from "@polyagent/db";
import {
  type FeedbackType,
  type GameFeedbackSchema,
  generateSnowflakeId,
  logger,
} from "@polyagent/shared";
import type { z } from "zod";

/**
 * Default score when no rating is provided.
 * Used as a neutral score for feedback without explicit rating.
 */
export const DEFAULT_FEEDBACK_SCORE = 50;

/**
 * Multiplier applied to rating (1-5) to get score (0-100).
 * Rating of 1 = 20, Rating of 5 = 100.
 */
export const RATING_SCORE_MULTIPLIER = 20;

/**
 * Maps feedback type to category string for database storage.
 */
export const FEEDBACK_CATEGORY_MAP: Record<FeedbackType, string> = {
  bug: "bug_report",
  feature_request: "feature_request",
  performance: "performance_issue",
};

/**
 * Calculate score from a user rating.
 *
 * @param rating - Optional rating from 1-5
 * @returns Score from 20-100 (if rating provided) or 50 (default)
 */
export function calculateFeedbackScore(
  rating: number | null | undefined,
): number {
  if (rating != null) {
    return rating * RATING_SCORE_MULTIPLIER;
  }
  return DEFAULT_FEEDBACK_SCORE;
}

export interface CreateFeedbackInput {
  userId: string;
  parsed: z.infer<typeof GameFeedbackSchema>;
}

export interface CreateFeedbackResult {
  id: string;
  fromUserId: string;
  score: number;
  feedbackType: FeedbackType;
}

/**
 * Creates a feedback record in the database.
 *
 * @param userId - The user ID submitting feedback
 * @param parsed - Validated feedback data
 * @returns The created feedback record
 */
export async function createGameFeedback(
  input: CreateFeedbackInput,
): Promise<CreateFeedbackResult> {
  const { userId, parsed } = input;
  const now = new Date();

  const metadata: Record<string, JsonValue> = {
    feedbackType: parsed.feedbackType,
    stepsToReproduce: parsed.stepsToReproduce ?? null,
    screenshotUrl: parsed.screenshotUrl ?? null,
    rating: parsed.rating ?? null,
  };

  const feedback = await db.feedback.create({
    data: {
      id: await generateSnowflakeId(),
      fromUserId: userId,
      toUserId: null,
      score: calculateFeedbackScore(parsed.rating),
      comment: parsed.description,
      category: FEEDBACK_CATEGORY_MAP[parsed.feedbackType],
      interactionType: "general_game_feedback",
      metadata,
      createdAt: now,
      updatedAt: now,
    },
  });

  logger.info("Game feedback submitted", {
    feedbackId: feedback.id,
    userId,
    type: parsed.feedbackType,
  });

  return {
    id: feedback.id,
    fromUserId: userId,
    score: feedback.score,
    feedbackType: parsed.feedbackType,
  };
}
