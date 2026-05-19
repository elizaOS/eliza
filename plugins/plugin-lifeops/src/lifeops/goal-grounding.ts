import type { LifeOpsGoalReviewState } from "../contracts/index.js";
import { LIFEOPS_REVIEW_STATES } from "../contracts/index.js";

export const GOAL_GROUNDING_STATES = [
  "grounded",
  "partial",
  "ungrounded",
] as const;

export type GoalGroundingState = (typeof GOAL_GROUNDING_STATES)[number];

export interface GoalGroundingMetadata {
  version: 1;
  groundingState: GoalGroundingState;
  summary: string | null;
  targetDomain: string | null;
  groundedAt: string | null;
  confidence: number | null;
  missingCriticalFields: string[];
  evidenceSignals: string[];
  reviewCadenceKind: string | null;
}

export interface GoalSemanticSuggestionMetadata {
  kind: string | null;
  title: string;
  detail: string;
}

export interface GoalSemanticReviewMetadata {
  reviewedAt: string;
  reviewState: LifeOpsGoalReviewState;
  progressScore: number | null;
  confidence: number | null;
  explanation: string;
  evidenceSummary: string | null;
  missingEvidence: string[];
  suggestions: GoalSemanticSuggestionMetadata[];
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function buildGoalGroundingMetadata(args: {
  confidence?: number | null;
  evidenceSignals?: string[];
  groundedAt?: string | null;
  groundingState: GoalGroundingState;
  missingCriticalFields?: string[];
  reviewCadenceKind?: string | null;
  summary?: string | null;
  targetDomain?: string | null;
}): GoalGroundingMetadata {
  return {
    version: 1,
    groundingState: args.groundingState,
    summary: args.summary ?? null,
    targetDomain: args.targetDomain ?? null,
    groundedAt: args.groundedAt ?? null,
    confidence:
      typeof args.confidence === "number" && Number.isFinite(args.confidence)
        ? Math.max(0, Math.min(1, args.confidence))
        : null,
    missingCriticalFields: Array.from(
      new Set((args.missingCriticalFields ?? []).filter(Boolean)),
    ),
    evidenceSignals: Array.from(
      new Set((args.evidenceSignals ?? []).filter(Boolean)),
    ),
    reviewCadenceKind:
      typeof args.reviewCadenceKind === "string" &&
      args.reviewCadenceKind.trim().length > 0
        ? args.reviewCadenceKind.trim()
        : null,
  };
}

export function mergeGoalGroundingMetadata(
  metadata: Record<string, unknown>,
  grounding: GoalGroundingMetadata,
): Record<string, unknown> {
  return {
    ...metadata,
    goalGrounding: grounding,
  };
}

export function readGoalGroundingMetadata(
  value: unknown,
): GoalGroundingMetadata | null {
  const record = asRecord(value);
  const candidate = asRecord(record?.goalGrounding ?? value);
  if (!candidate) {
    return null;
  }
  const groundingState = asText(candidate.groundingState);
  if (
    !groundingState ||
    !GOAL_GROUNDING_STATES.includes(groundingState as GoalGroundingState)
  ) {
    return null;
  }
  return buildGoalGroundingMetadata({
    confidence: asFiniteNumber(candidate.confidence),
    evidenceSignals: asStringArray(candidate.evidenceSignals),
    groundedAt: asText(candidate.groundedAt),
    groundingState: groundingState as GoalGroundingState,
    missingCriticalFields: asStringArray(candidate.missingCriticalFields),
    reviewCadenceKind: asText(candidate.reviewCadenceKind),
    summary: asText(candidate.summary),
    targetDomain: asText(candidate.targetDomain),
  });
}

export function buildGoalSemanticReviewMetadata(args: {
  confidence?: number | null;
  evidenceSummary?: string | null;
  explanation: string;
  missingEvidence?: string[];
  progressScore?: number | null;
  reviewState: LifeOpsGoalReviewState;
  reviewedAt: string;
  suggestions?: GoalSemanticSuggestionMetadata[];
}): GoalSemanticReviewMetadata {
  return {
    reviewedAt: args.reviewedAt,
    reviewState: args.reviewState,
    progressScore:
      typeof args.progressScore === "number" &&
      Number.isFinite(args.progressScore)
        ? Math.max(0, Math.min(1, args.progressScore))
        : null,
    confidence:
      typeof args.confidence === "number" && Number.isFinite(args.confidence)
        ? Math.max(0, Math.min(1, args.confidence))
        : null,
    explanation: args.explanation.trim(),
    evidenceSummary: args.evidenceSummary ?? null,
    missingEvidence: Array.from(
      new Set((args.missingEvidence ?? []).filter(Boolean)),
    ),
    suggestions: (args.suggestions ?? [])
      .map((suggestion) => ({
        kind: asText(suggestion.kind),
        title: suggestion.title.trim(),
        detail: suggestion.detail.trim(),
      }))
      .filter(
        (suggestion) =>
          suggestion.title.length > 0 && suggestion.detail.length > 0,
      ),
  };
}

export function mergeGoalSemanticReviewMetadata(
  metadata: Record<string, unknown>,
  review: GoalSemanticReviewMetadata,
): Record<string, unknown> {
  return {
    ...metadata,
    goalSemanticReview: review,
  };
}

export function readGoalSemanticReviewMetadata(
  value: unknown,
): GoalSemanticReviewMetadata | null {
  const record = asRecord(value);
  const candidate = asRecord(record?.goalSemanticReview ?? value);
  if (!candidate) {
    return null;
  }
  const reviewedAt = asText(candidate.reviewedAt);
  const reviewState = asText(candidate.reviewState);
  const explanation = asText(candidate.explanation);
  if (
    !reviewedAt ||
    !reviewState ||
    !LIFEOPS_REVIEW_STATES.includes(reviewState as LifeOpsGoalReviewState) ||
    !explanation
  ) {
    return null;
  }
  return buildGoalSemanticReviewMetadata({
    confidence: asFiniteNumber(candidate.confidence),
    evidenceSummary: asText(candidate.evidenceSummary),
    explanation,
    missingEvidence: asStringArray(candidate.missingEvidence),
    progressScore: asFiniteNumber(candidate.progressScore),
    reviewState: reviewState as LifeOpsGoalReviewState,
    reviewedAt,
    suggestions: Array.isArray(candidate.suggestions)
      ? candidate.suggestions
          .map((entry) => {
            const suggestion = asRecord(entry);
            const title = asText(suggestion?.title);
            const detail = asText(suggestion?.detail);
            if (!title || !detail) {
              return null;
            }
            return {
              kind: asText(suggestion?.kind),
              title,
              detail,
            };
          })
          .filter(
            (entry): entry is GoalSemanticSuggestionMetadata => entry !== null,
          )
      : [],
  });
}
