/**
 * Game Feedback Validation Schema
 *
 * Shared schema for validating game feedback submissions.
 * Used by both the API route and test files.
 */

import { z } from "zod";

export const FeedbackTypeSchema = z.enum([
  "bug",
  "feature_request",
  "performance",
]);
export type FeedbackType = z.infer<typeof FeedbackTypeSchema>;

/**
 * Shared feedback type configuration.
 * Contains base labels and formatting used across UI and Linear integration.
 * Consumers can extend with their own properties (icons, colors, etc.).
 */
export const FEEDBACK_TYPE_CONFIG: Record<
  FeedbackType,
  {
    /** Human-readable label for the feedback type */
    label: string;
    /** Short heading for issue titles/reports */
    heading: string;
    /** Emoji representation for text contexts (Linear, notifications) */
    emoji: string;
  }
> = {
  bug: {
    label: "Bug Report",
    heading: "Bug Report",
    emoji: "🐛",
  },
  feature_request: {
    label: "Feature Request",
    heading: "Feature Request",
    emoji: "✨",
  },
  performance: {
    label: "Performance Issue",
    heading: "Performance Issue",
    emoji: "⚡",
  },
};

/**
 * Validation limits exported for UI consumption.
 * Keeps schema and UI character counters in sync.
 */
export const FEEDBACK_DESCRIPTION_MIN_LENGTH = 10;
export const FEEDBACK_DESCRIPTION_MAX_LENGTH = 5000;
export const FEEDBACK_STEPS_MAX_LENGTH = 2000;

/**
 * Allowed domains for screenshot URLs.
 * Prevents users from injecting arbitrary URLs.
 */
const ALLOWED_SCREENSHOT_DOMAINS = [
  // Vercel Blob Storage (production)
  ".public.blob.vercel-storage.com",
  // MinIO (local development)
  "localhost:9000",
  "127.0.0.1:9000",
];

/**
 * Validates that a screenshot URL is from an allowed domain.
 * Also allows relative URLs (local uploads like /uploads/...).
 */
function isAllowedScreenshotUrl(url: string): boolean {
  // Allow relative URLs (local uploads)
  if (url.startsWith("/uploads/")) {
    return true;
  }

  // Parse the URL and check domain
  try {
    const parsed = new URL(url);
    return ALLOWED_SCREENSHOT_DOMAINS.some(
      (domain) =>
        parsed.hostname === domain ||
        parsed.hostname.endsWith(domain) ||
        parsed.host === domain,
    );
  } catch {
    return false;
  }
}

export const GameFeedbackSchema = z
  .object({
    feedbackType: FeedbackTypeSchema,
    description: z
      .string()
      .trim()
      .min(
        FEEDBACK_DESCRIPTION_MIN_LENGTH,
        `Description must be at least ${FEEDBACK_DESCRIPTION_MIN_LENGTH} characters`,
      )
      .max(FEEDBACK_DESCRIPTION_MAX_LENGTH),
    stepsToReproduce: z
      .string()
      .trim()
      .max(FEEDBACK_STEPS_MAX_LENGTH)
      .optional(),
    screenshotUrl: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((val) => (val === "" ? undefined : val))
      .refine(
        (val) => val === undefined || isAllowedScreenshotUrl(val),
        "Screenshot URL must be from an allowed domain",
      ),
    rating: z.number().int().min(1).max(5).optional(),
  })
  .refine((data) => data.feedbackType !== "bug" || !!data.stepsToReproduce, {
    message: "Steps to reproduce are required for bug reports",
    path: ["stepsToReproduce"],
  })
  .refine(
    (data) =>
      data.feedbackType !== "feature_request" || data.rating !== undefined,
    {
      message: "Rating is required for feature requests",
      path: ["rating"],
    },
  );

export type GameFeedback = z.infer<typeof GameFeedbackSchema>;
