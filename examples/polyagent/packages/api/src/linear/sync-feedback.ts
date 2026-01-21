/**
 * Sync feedback to Linear by creating an issue.
 * This function is designed to be fire-and-forget from the API route.
 * Includes retry logic with exponential backoff for transient failures.
 */

import { db } from "@polyagent/db";
import { FeedbackTypeSchema, logger } from "@polyagent/shared";
import { z } from "zod";
import { createLinearIssue } from "./client";
import { formatFeedbackForLinear } from "./format-feedback";

/** Maximum number of retry attempts for Linear API calls */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff (doubles each retry) */
const BASE_RETRY_DELAY_MS = 1000;

/**
 * Sleep for a specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic and exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  context: { feedbackId: string },
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on the last attempt
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
        logger.warn("Linear API call failed, retrying", {
          feedbackId: context.feedbackId,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          delayMs: delay,
          error: lastError.message,
        });
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Zod schema for validating feedback metadata from the database.
 * Ensures type safety when parsing JSON metadata.
 * Reuses FeedbackTypeSchema from shared package for DRY compliance.
 */
const FeedbackMetadataSchema = z.object({
  feedbackType: FeedbackTypeSchema.catch("bug"),
  stepsToReproduce: z.string().nullable().catch(null),
  screenshotUrl: z.string().nullable().catch(null),
  rating: z.number().nullable().catch(null),
});

type FeedbackMetadata = z.infer<typeof FeedbackMetadataSchema>;

export interface LinearConfig {
  apiKey: string;
  teamId: string;
  gameFeedbackLabelId: string | null;
}

export interface FeedbackUser {
  id: string;
  email: string | null;
}

/**
 * Zod schema for validating Linear sync metadata from the database.
 * Used for idempotency check to prevent duplicate issue creation.
 */
const LinearSyncMetadataSchema = z.object({
  linearIssueId: z.string().optional().catch(undefined),
});

/**
 * Syncs a feedback record to Linear by creating an issue.
 * Updates the feedback metadata with the Linear issue reference.
 *
 * Idempotent: If feedback already has a linearIssueId, skips creation.
 */
export async function syncFeedbackToLinear(
  config: LinearConfig,
  feedbackId: string,
  user: FeedbackUser,
): Promise<void> {
  // Fetch feedback from DB to get current state (ensures consistency)
  const feedback = await db.feedback.findUnique({
    where: { id: feedbackId },
    select: { comment: true, metadata: true },
  });

  if (!feedback) {
    logger.warn("Feedback not found for Linear sync", { feedbackId });
    return;
  }

  // Safely parse metadata using Zod schema
  const rawMetadata =
    feedback.metadata && typeof feedback.metadata === "object"
      ? feedback.metadata
      : {};

  // Idempotency check: skip if already synced to Linear
  const syncMetadata = LinearSyncMetadataSchema.parse(rawMetadata);
  if (syncMetadata.linearIssueId) {
    logger.info("Feedback already synced to Linear, skipping", {
      feedbackId,
      linearIssueId: syncMetadata.linearIssueId,
    });
    return;
  }

  const metadata: FeedbackMetadata = FeedbackMetadataSchema.parse(rawMetadata);

  const formatted = formatFeedbackForLinear({
    id: feedbackId,
    feedbackType: metadata.feedbackType,
    description: feedback.comment ?? "",
    stepsToReproduce: metadata.stepsToReproduce,
    screenshotUrl: metadata.screenshotUrl,
    rating: metadata.rating,
    userId: user.id,
    userEmail: user.email,
  });

  // Create Linear issue with retry logic for transient failures
  const issue = await withRetry(
    () =>
      createLinearIssue(config.apiKey, {
        teamId: config.teamId,
        title: formatted.title,
        description: formatted.description,
        labelIds: config.gameFeedbackLabelId
          ? [config.gameFeedbackLabelId]
          : undefined,
      }),
    { feedbackId },
  );

  // Merge update: fetch fresh metadata to preserve concurrent updates.
  // Note: This is not truly atomic (TOCTOU gap exists), but the idempotency
  // check above prevents duplicate Linear issues, and metadata merge is
  // additive only. Risk is acceptable for fire-and-forget background sync.
  const freshFeedback = await db.feedback.findUnique({
    where: { id: feedbackId },
    select: { metadata: true },
  });

  const freshMetadata =
    freshFeedback?.metadata && typeof freshFeedback.metadata === "object"
      ? (freshFeedback.metadata as Record<string, unknown>)
      : {};

  await db.feedback.update({
    where: { id: feedbackId },
    data: {
      metadata: {
        ...freshMetadata,
        linearIssueId: issue.id,
        linearIssueIdentifier: issue.identifier,
        linearIssueUrl: issue.url,
      },
    },
  });

  logger.info("Linear issue created for feedback", {
    feedbackId,
    issueId: issue.id,
    identifier: issue.identifier,
  });
}
