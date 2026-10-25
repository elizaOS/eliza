/**
 * `DocumentRequest` domain type.
 *
 * PRD: `prd-lifeops-executive-assistant.md` §Docs And Portals.
 *
 * A DocumentRequest is anything that needs signature, review, upload, or
 * approval by a deadline. The Wave-1 scaffold stores these in-memory; the
 * Wave-2 follow-up is to persist them via the existing repository surface
 * alongside `SCHEDULED_TASK` linkage.
 */

export type DocumentRequestStatus =
  | "draft"
  | "pending"
  | "in_progress"
  | "completed"
  | "expired"
  | "cancelled";

export type DocumentRequestKind =
  | "signature"
  | "approval"
  | "upload"
  | "collect_id";

export interface DocumentRequest {
  /** Stable id. */
  readonly id: string;
  /** What this request is asking for. */
  readonly kind: DocumentRequestKind;
  /** Entity (person) we're asking; absent for self-upload flows. */
  readonly requesteeEntityId?: string;
  /** Short label, e.g. "Partnership NDA", "Speaker deck for Solana Breakpoint". */
  readonly title: string;
  /** ISO 8601 deadline; the SCHEDULED_TASK trigger references this. */
  readonly deadline?: string;
  /** Portal endpoint for `upload` / `collect_id` flows. */
  readonly portalUrl?: string;
  /** "deck" | "headshot" | "id" | "form" | ... — free-form label. */
  readonly assetKind?: string;
  readonly status: DocumentRequestStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  /** Link to SCHEDULED_TASK that tracks the deadline. */
  readonly scheduledTaskId?: string;
  /** Link to an escalation ladder for stronger nudges as deadline approaches. */
  readonly escalationLadderId?: string;
  /** Link to ApprovalRequest while gated on owner approval (draft state). */
  readonly approvalRequestId?: string;
  /** Free-form note from the requester. */
  readonly note?: string;
}
