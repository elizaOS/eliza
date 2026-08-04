import { SupportedChain } from "../types";

export type ScamPatternId = "raise_and_drain";

export const VALID_SCAM_PATTERN_IDS: ReadonlySet<ScamPatternId> = new Set([
  "raise_and_drain",
]);

export type ReviewStatus = "pending" | "accepted" | "rejected";

export const VALID_REVIEW_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  "pending",
  "accepted",
  "rejected",
]);

// Legal review-status transitions, same "single source of truth, throw on
// anything unenumerated" convention as approval/store.ts's
// ALLOWED_TRANSITIONS - no fallback, no silent normalization.
export const ALLOWED_REVIEW_TRANSITIONS: Readonly<
  Record<ReviewStatus, ReadonlyArray<ReviewStatus>>
> = {
  pending: ["accepted", "rejected"],
  accepted: [],
  rejected: [],
};

export class ReviewStateTransitionError extends Error {
  constructor(id: string, from: ReviewStatus, to: ReviewStatus) {
    super(
      `[ScamPatternCandidates] illegal review transition for ${id}: ${from} -> ${to}`,
    );
    this.name = "ReviewStateTransitionError";
  }
}

export class ScamPatternCandidateNotFoundError extends Error {
  constructor(id: string) {
    super(`[ScamPatternCandidates] candidate not found: ${id}`);
    this.name = "ScamPatternCandidateNotFoundError";
  }
}

export type LabelMatchReference = {
  address: string;
  label: string;
  relationship: string;
};

export type ScamPatternCandidateInsert = {
  chain: SupportedChain;
  address: string;
  patterns: ScamPatternId[];
  evidence: Record<string, unknown>;
  hasKnownLabelMatch: boolean;
  labelMatches: LabelMatchReference[];
};

export type ScamPatternCandidate = {
  id: string;
  chain: SupportedChain;
  address: string;
  patterns: ScamPatternId[];
  evidence: Record<string, unknown>;
  hasKnownLabelMatch: boolean;
  labelMatches: LabelMatchReference[];
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  createdAt: Date;
};

export type ScamPatternCandidateResolution = {
  reviewedBy: string;
  reviewNotes: string | null;
};

export type ScamPatternCandidateListFilter = {
  chain?: SupportedChain;
  reviewStatus?: ReviewStatus;
  limit: number;
};
