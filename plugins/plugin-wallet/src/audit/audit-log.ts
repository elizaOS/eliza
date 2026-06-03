import { createHash } from "node:crypto";
import type {
  ActionFailureCode,
  ValidateFailureCode,
} from "../actions/failure-codes.js";
import type { SignScope } from "../wallet/pending.js";

const AUDIT_HASH_ALGORITHM = "sha256";
const AUDIT_GENESIS_HASH = "0".repeat(64);

export type AuditKind =
  | "action_validate_start"
  | "action_validate_end"
  | "action_handler_start"
  | "action_handler_end"
  | "wallet_sign_request"
  | "wallet_sign_result"
  | "approval_requested"
  | "approval_resolved"
  | "automation_trigger_fired"
  | "automation_trigger_skipped";

export type AuditOutcome =
  | "ok"
  | "validate_fail"
  | "handler_fail"
  | "pending_approval"
  | "approved"
  | "rejected";

/**
 * Row shape for the append-only audit log.
 */
export interface AuditLogRow {
  readonly id: bigint;
  readonly ts: number;
  readonly actor: "agent" | "user" | "automation";
  readonly kind: AuditKind;
  readonly scope: SignScope | null;
  readonly actionName: string | null;
  readonly paramsHash: string;
  readonly approvalId: string | null;
  readonly outcome: AuditOutcome;
  readonly failureCode: ValidateFailureCode | ActionFailureCode | null;
  readonly detail: string | null;
  readonly prevHash: string;
  readonly rowHash: string;
}

export type AuditLogRowInput = Omit<
  AuditLogRow,
  "id" | "ts" | "prevHash" | "rowHash"
> & {
  readonly id?: bigint;
  readonly ts?: number;
  readonly prevHash?: string | null;
};

export function createAuditLogRow(input: AuditLogRowInput): AuditLogRow {
  const rowWithoutHash = {
    id: input.id ?? 0n,
    ts: input.ts ?? Date.now(),
    actor: input.actor,
    kind: input.kind,
    scope: input.scope,
    actionName: input.actionName,
    paramsHash: input.paramsHash,
    approvalId: input.approvalId,
    outcome: input.outcome,
    failureCode: input.failureCode,
    detail: input.detail,
    prevHash: input.prevHash ?? AUDIT_GENESIS_HASH,
  };
  return {
    ...rowWithoutHash,
    rowHash: computeAuditLogRowHash(rowWithoutHash),
  };
}

export function verifyAuditLogRow(row: AuditLogRow): boolean {
  return row.rowHash === computeAuditLogRowHash(row);
}

function computeAuditLogRowHash(row: Omit<AuditLogRow, "rowHash">): string {
  const canonical = JSON.stringify({
    id: row.id.toString(),
    ts: row.ts,
    actor: row.actor,
    kind: row.kind,
    scope: row.scope,
    actionName: row.actionName,
    paramsHash: row.paramsHash,
    approvalId: row.approvalId,
    outcome: row.outcome,
    failureCode: row.failureCode,
    detail: row.detail,
    prevHash: row.prevHash,
  });
  return createHash(AUDIT_HASH_ALGORITHM).update(canonical).digest("hex");
}
