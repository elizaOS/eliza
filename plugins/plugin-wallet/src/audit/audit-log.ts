import type {
  ActionFailureCode,
  ValidateFailureCode,
} from "../actions/failure-codes.js";
import type { SignScope } from "../wallet/pending.js";

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
 * Row shape for the append-only audit log (hash-chained at rest).
 * Implementation + SQL migration land with Phase 1 runtime wiring.
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
