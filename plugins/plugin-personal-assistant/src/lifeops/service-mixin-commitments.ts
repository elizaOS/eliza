/**
 * Commitment-audit service contract and redacted owner-facing DTOs. The
 * commitments domain implements this surface; the LifeOps service composes it
 * without exposing persistence-only ledger identity or metadata fields.
 */
import type {
  LifeOpsCommitmentKind,
  LifeOpsCommitmentSource,
} from "./commitments/ledger.js";

export interface LifeOpsCommitmentRegretAuditItem {
  readonly id: string;
  readonly source: LifeOpsCommitmentSource;
  readonly kind: LifeOpsCommitmentKind;
  readonly summary: string;
  readonly counterparty: string | null;
  readonly dueAt: string | null;
  readonly confidence: number;
  readonly status: "open" | "tracked";
  readonly scheduledTaskId: string | null;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface LifeOpsCommitmentRegretAuditResponse {
  readonly generatedAt: string;
  readonly horizonDays: number;
  readonly horizonEndAt: string;
  readonly items: readonly LifeOpsCommitmentRegretAuditItem[];
}

export interface LifeOpsCommitmentService {
  getCommitmentRegretAudit(input: {
    horizonDays: number;
    nowIso?: string;
  }): Promise<LifeOpsCommitmentRegretAuditResponse>;
}
