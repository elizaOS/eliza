/**
 * Content Moderation Service
 *
 * Two-fold auto-moderation system:
 * 1. First layer: Keyword trigger using expletives package (fast, sync)
 * 2. Second layer: OpenAI Moderation API for serious violations (async, parallel)
 *
 * IMPORTANT: This runs async and does NOT block generation responses.
 * Violations are tracked and escalated (refuse → warn → flag for ban).
 *
 * We only care about: sexual/minors and self-harm categories.
 */

import { hasBadWords, minimalBadWordsArray } from "expletives";
import { logger } from "@/lib/utils/logger";
import { adminService } from "./admin";

// OpenAI Moderation API types
interface ModerationCategory {
  sexual: boolean;
  "sexual/minors": boolean;
  harassment: boolean;
  "harassment/threatening": boolean;
  hate: boolean;
  "hate/threatening": boolean;
  illicit: boolean;
  "illicit/violent": boolean;
  "self-harm": boolean;
  "self-harm/intent": boolean;
  "self-harm/instructions": boolean;
  violence: boolean;
  "violence/graphic": boolean;
}

interface ModerationCategoryScores {
  sexual: number;
  "sexual/minors": number;
  harassment: number;
  "harassment/threatening": number;
  hate: number;
  "hate/threatening": number;
  illicit: number;
  "illicit/violent": number;
  "self-harm": number;
  "self-harm/intent": number;
  "self-harm/instructions": number;
  violence: number;
  "violence/graphic": number;
}

interface ModerationResult {
  flagged: boolean;
  categories: ModerationCategory;
  category_scores: ModerationCategoryScores;
}

interface OpenAIModerationResponse {
  id: string;
  model: string;
  results: ModerationResult[];
}

/**
 * Categories we care about for legal compliance
 */
export type CriticalCategory =
  | "sexual/minors"
  | "self-harm"
  | "self-harm/intent"
  | "self-harm/instructions";

/**
 * Error thrown when moderation blocks a response
 */
export class ModerationBlockedError extends Error {
  readonly flaggedCategories: CriticalCategory[];
  readonly action: "refused" | "warned" | "flagged_for_ban";
  readonly scores: Partial<Record<CriticalCategory, number>>;

  constructor(
    message: string,
    result: AsyncModerationResult & {
      action?: "refused" | "warned" | "flagged_for_ban";
    },
  ) {
    super(message);
    this.name = "ModerationBlockedError";
    this.flaggedCategories = result.flaggedCategories;
    this.action = result.action ?? "refused";
    this.scores = result.scores;
  }
}

/**
 * Result of async moderation check
 */
export interface AsyncModerationResult {
  /** Whether critical content was detected */
  flagged: boolean;
  /** Categories that were flagged */
  flaggedCategories: CriticalCategory[];
  /** Confidence scores for flagged categories */
  scores: Partial<Record<CriticalCategory, number>>;
  /** Raw response from OpenAI */
  raw?: ModerationResult;
}

/**
 * User violation record for escalation tracking
 */
export interface ModerationViolation {
  userId: string;
  roomId?: string;
  messageText: string;
  categories: CriticalCategory[];
  scores: Partial<Record<CriticalCategory, number>>;
  timestamp: Date;
  action: "refused" | "warned" | "flagged_for_ban";
}

/**
 * Escalation thresholds
 */
const THRESHOLDS = {
  // Score thresholds for flagging (0-1 scale)
  "sexual/minors": 0.3, // Very strict for CSAM
  "self-harm": 0.5,
  "self-harm/intent": 0.4,
  "self-harm/instructions": 0.4,

  // Violation counts for escalation
  WARN_AFTER_VIOLATIONS: 2,
  FLAG_FOR_BAN_AFTER_VIOLATIONS: 5,
} as const;

/**
 * Check if text contains minimal bad words that warrant deeper moderation
 */
function containsMinimalBadWords(text: string): boolean {
  const lowerText = text.toLowerCase();
  return minimalBadWordsArray.some((word: string) => lowerText.includes(word.toLowerCase()));
}

let hasLoggedModerationUnavailable = false;

const OPENAI_MODERATIONS_URL = "https://api.openai.com/v1/moderations";

function emptyModerationResult(): AsyncModerationResult {
  return { flagged: false, flaggedCategories: [], scores: {} };
}

async function callModeration(text: string): Promise<AsyncModerationResult> {
  // Allow explicit disable (useful for self-hosted/dev environments).
  if (process.env.CONTENT_MODERATION_ENABLED === "false") {
    if (!hasLoggedModerationUnavailable) {
      hasLoggedModerationUnavailable = true;
      logger.warn(
        "[ContentModeration] Moderation explicitly disabled via CONTENT_MODERATION_ENABLED=false",
      );
    }
    return emptyModerationResult();
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (!hasLoggedModerationUnavailable) {
      hasLoggedModerationUnavailable = true;
      logger.warn(
        "[ContentModeration] OPENAI_API_KEY not configured; skipping async moderation checks",
      );
    }
    return emptyModerationResult();
  }

  const response = await fetch(OPENAI_MODERATIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input: text,
    }),
  });

  if (!response.ok) {
    // Moderation is explicitly non-blocking. Treat permission/availability
    // failures as a no-op rather than surfacing per-request errors.
    if ([401, 403, 404, 405].includes(response.status)) {
      if (!hasLoggedModerationUnavailable) {
        hasLoggedModerationUnavailable = true;
        logger.warn(
          "[ContentModeration] OpenAI moderation endpoint unavailable; skipping moderation checks",
          {
            status: response.status,
            statusText: response.statusText,
          },
        );
      }
      return emptyModerationResult();
    }

    throw new Error(`Moderation API failed (openai): ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OpenAIModerationResponse;
  const result = data.results[0];

  if (!result) {
    throw new Error("Moderation API returned no results");
  }

  // Check only the categories we care about
  const flaggedCategories: CriticalCategory[] = [];
  const scores: Partial<Record<CriticalCategory, number>> = {};

  const criticalCategories: CriticalCategory[] = [
    "sexual/minors",
    "self-harm",
    "self-harm/intent",
    "self-harm/instructions",
  ];

  for (const category of criticalCategories) {
    const score = result.category_scores[category];
    const threshold = THRESHOLDS[category];

    if (score >= threshold) {
      flaggedCategories.push(category);
      scores[category] = score;
    }
  }

  return {
    flagged: flaggedCategories.length > 0,
    flaggedCategories,
    scores,
    raw: result,
  };
}

/**
 * Content Moderation Service
 *
 * Implements async moderation that doesn't block generation:
 * 1. Fast keyword check (sync) - triggers deeper moderation
 * 2. OpenAI Moderation API (async) - runs in parallel
 * 3. Escalating responses based on violation history (stored in DB via adminService)
 */
class ContentModerationService {
  /**
   * Quick sync check if content needs async moderation
   * Use this to decide whether to trigger async moderation
   */
  needsAsyncModeration(text: string): boolean {
    return hasBadWords(text) || containsMinimalBadWords(text);
  }

  /**
   * Perform async moderation using OpenAI's moderation endpoint
   * This should be called in parallel with generation, not blocking it
   *
   * @param text - The text to moderate
   * @param userId - User ID for violation tracking
   * @param roomId - Optional room ID for context
   * @returns Moderation result with action to take
   */
  async moderateAsync(
    text: string,
    userId: string,
    roomId?: string,
  ): Promise<
    AsyncModerationResult & {
      action?: "refused" | "warned" | "flagged_for_ban";
    }
  > {
    const result = await callModeration(text);

    if (!result.flagged) {
      return result;
    }

    // Get current violation count from DB
    const status = await adminService.getUserModerationStatus(userId);
    const currentCount = status?.totalViolations ?? 0;

    // Determine action based on history
    let action: "refused" | "warned" | "flagged_for_ban" = "refused";
    if (currentCount >= THRESHOLDS.FLAG_FOR_BAN_AFTER_VIOLATIONS) {
      action = "flagged_for_ban";
    } else if (currentCount >= THRESHOLDS.WARN_AFTER_VIOLATIONS) {
      action = "warned";
    }

    // Record the violation in DB
    await adminService.recordViolation({
      userId,
      roomId,
      messageText: text.slice(0, 500),
      categories: result.flaggedCategories,
      scores: result.scores as Record<string, number>,
      action,
    });

    return { ...result, action };
  }

  /**
   * Fire-and-forget async moderation
   * Runs moderation in background and handles violations without blocking
   *
   * @param text - The text to moderate
   * @param userId - User ID for violation tracking
   * @param roomId - Optional room ID
   * @param onViolation - Callback when violation is detected
   */
  moderateInBackground(
    text: string,
    userId: string,
    roomId?: string,
    onViolation?: (
      result: AsyncModerationResult & {
        action: "refused" | "warned" | "flagged_for_ban";
      },
    ) => void,
  ): void {
    // Only run async moderation if keywords suggest it's needed
    if (!this.needsAsyncModeration(text)) {
      return;
    }

    // Fire and forget - errors are logged but don't propagate
    // This is intentional: moderation should not block user experience
    this.moderateAsync(text, userId, roomId)
      .then((result) => {
        if (result.flagged && result.action && onViolation) {
          onViolation(
            result as AsyncModerationResult & {
              action: "refused" | "warned" | "flagged_for_ban";
            },
          );
        }
      })
      .catch((error) => {
        // Log error but don't propagate - moderation failures should not block users
        logger.error("[ContentModeration] Background moderation failed", {
          error: error instanceof Error ? error.message : String(error),
          userId,
          roomId,
        });
      });
  }

  /**
   * Race moderation against work - blocks if moderation finishes first with violation
   *
   * This is the recommended pattern for non-streaming responses:
   * 1. Start moderation and work in parallel
   * 2. If moderation finishes first AND finds violation → throw error
   * 3. If work finishes first → return result (moderation continues in background)
   * 4. If moderation finishes first but no violation → wait for work
   *
   * @param text - The text to moderate
   * @param userId - User ID for violation tracking
   * @param work - The async work to race against (e.g., AI generation)
   * @param roomId - Optional room ID for context
   * @returns The result of work, or throws if moderation blocks
   */
  async moderateWithRace<T>(
    text: string,
    userId: string,
    work: () => Promise<T>,
    roomId?: string,
  ): Promise<T> {
    // Skip moderation if no keywords detected
    if (!this.needsAsyncModeration(text)) {
      return work();
    }

    // Create moderation promise
    const moderationPromise = this.moderateAsync(text, userId, roomId);

    // Create work promise
    const workPromise = work();

    // Race them - but with special handling
    // We use Promise.race with a wrapper that tracks which finished
    type RaceResult =
      | {
          type: "moderation";
          result: AsyncModerationResult & {
            action?: "refused" | "warned" | "flagged_for_ban";
          };
        }
      | { type: "work"; result: T };

    const moderationRacer: Promise<RaceResult> = moderationPromise.then((result) => ({
      type: "moderation" as const,
      result,
    }));

    const workRacer: Promise<RaceResult> = workPromise.then((result) => ({
      type: "work" as const,
      result,
    }));

    const firstResult = await Promise.race([moderationRacer, workRacer]);

    if (firstResult.type === "moderation") {
      const modResult = firstResult.result;

      if (modResult.flagged && modResult.action) {
        // Moderation finished first with a violation - BLOCK
        logger.warn("[ContentModeration] Blocking response - moderation detected violation", {
          userId,
          roomId,
          categories: modResult.flaggedCategories,
          action: modResult.action,
        });

        throw new ModerationBlockedError(
          `Content policy violation detected: ${modResult.flaggedCategories.join(", ")}`,
          modResult,
        );
      }

      // Moderation finished first but no violation - wait for work
      return workPromise;
    }

    // Work finished first - let moderation continue in background
    // The moderation promise will still complete and record any violations
    moderationPromise
      .then((result) => {
        if (result.flagged) {
          logger.info("[ContentModeration] Violation detected after response sent", {
            userId,
            roomId,
            categories: result.flaggedCategories,
            action: result.action,
          });
        }
      })
      .catch((error) => {
        logger.error("[ContentModeration] Background moderation failed after response", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return firstResult.result;
  }

  /**
   * Start moderation and return a checker function for streaming responses
   *
   * Use this pattern for streaming:
   * 1. Call startModerationCheck() before streaming
   * 2. It returns a checker function
   * 3. Call the checker before starting to stream - if moderation finished with violation, it throws
   * 4. If checker passes, start streaming (moderation continues in background)
   *
   * @param text - The text to moderate
   * @param userId - User ID for violation tracking
   * @param roomId - Optional room ID
   * @returns Object with check() function and cleanup
   */
  startModerationCheck(
    text: string,
    userId: string,
    roomId?: string,
  ): {
    /** Check if moderation has flagged - throws if violation detected before streaming */
    checkBeforeStream: () => Promise<void>;
    /** Get the moderation promise for background tracking */
    moderationPromise: Promise<
      AsyncModerationResult & {
        action?: "refused" | "warned" | "flagged_for_ban";
      }
    > | null;
  } {
    // Skip if no keywords
    if (!this.needsAsyncModeration(text)) {
      return {
        checkBeforeStream: async () => {
          /* no-op */
        },
        moderationPromise: null,
      };
    }

    // Start moderation
    const moderationPromise = this.moderateAsync(text, userId, roomId);
    let moderationResult:
      | (AsyncModerationResult & {
          action?: "refused" | "warned" | "flagged_for_ban";
        })
      | null = null;
    let moderationError: Error | null = null;

    // Track when moderation completes
    moderationPromise
      .then((result) => {
        moderationResult = result;
      })
      .catch((error) => {
        moderationError = error instanceof Error ? error : new Error(String(error));
      });

    return {
      checkBeforeStream: async () => {
        // Give moderation a tiny window to complete (10ms)
        await new Promise((resolve) => setTimeout(resolve, 10));

        // If moderation completed with violation, block
        if (moderationResult?.flagged && moderationResult.action) {
          logger.warn("[ContentModeration] Blocking stream - moderation detected violation", {
            userId,
            roomId,
            categories: moderationResult.flaggedCategories,
            action: moderationResult.action,
          });

          throw new ModerationBlockedError(
            `Content policy violation detected: ${moderationResult.flaggedCategories.join(", ")}`,
            moderationResult,
          );
        }

        // If moderation errored, log but don't block
        if (moderationError) {
          logger.error("[ContentModeration] Moderation check failed, allowing stream", {
            error: moderationError.message,
          });
        }

        // Otherwise, allow stream to proceed
        // Moderation will continue in background
      },
      moderationPromise,
    };
  }

  /**
   * Check if user should be blocked based on violation history (from DB)
   */
  async shouldBlockUser(userId: string): Promise<boolean> {
    return adminService.shouldBlockUser(userId);
  }

  /**
   * Get violation count for a user (from DB)
   */
  async getViolationCount(userId: string): Promise<number> {
    const status = await adminService.getUserModerationStatus(userId);
    return status?.totalViolations ?? 0;
  }

  /**
   * Get recent violations for admin view (from DB)
   */
  async getRecentViolations(limit = 100): Promise<ModerationViolation[]> {
    const violations = await adminService.getRecentViolations(limit);
    return violations.map((v) => ({
      userId: v.userId,
      roomId: v.roomId ?? undefined,
      messageText: v.messageText,
      categories: v.categories as CriticalCategory[],
      scores: v.scores as Partial<Record<CriticalCategory, number>>,
      timestamp: v.createdAt,
      action: v.action as "refused" | "warned" | "flagged_for_ban",
    }));
  }

  /**
   * Get violations for a specific user (from DB)
   */
  async getUserViolations(userId: string): Promise<ModerationViolation[]> {
    const violations = await adminService.getUserViolations(userId);
    return violations.map((v) => ({
      userId: v.userId,
      roomId: v.roomId ?? undefined,
      messageText: v.messageText,
      categories: v.categories as CriticalCategory[],
      scores: v.scores as Partial<Record<CriticalCategory, number>>,
      timestamp: v.createdAt,
      action: v.action as "refused" | "warned" | "flagged_for_ban",
    }));
  }

  /**
   * Reset violation count for a user (admin action)
   */
  async resetViolations(userId: string): Promise<void> {
    await adminService.unbanUser(userId, "system");
  }

  /**
   * Get all users flagged for ban (from DB)
   */
  async getUsersFlaggedForBan(): Promise<string[]> {
    const flagged = await adminService.getUsersFlaggedForReview();
    return flagged
      .filter((u) => u.totalViolations >= THRESHOLDS.FLAG_FOR_BAN_AFTER_VIOLATIONS)
      .map((u) => u.userId);
  }
}

export const contentModerationService = new ContentModerationService();
