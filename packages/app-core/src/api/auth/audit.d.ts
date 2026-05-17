/**
 * Auth audit emitter.
 *
 * Every sensitive auth action ends up in two places:
 *   1. `auth_audit_events` table via `AuthStore.appendAuditEvent`.
 *   2. JSONL file at `<state>/auth/audit.log`, rotated at 10MB, so the
 *      operator can read history even if pglite is wiped.
 *
 * Both writes happen synchronously from the caller's perspective. If the DB
 * write throws the file write still happens (and vice versa) — the operator
 * notices a divergence rather than losing the event entirely.
 *
 * Token-shaped values (20+ characters of `[A-Za-z0-9_-]`) are redacted in
 * `metadata` before either write, so a misconfigured caller can't smuggle a
 * bearer token into an audit row.
 */
import type { RuntimeEnvRecord } from "@elizaos/shared";
import type { AuthStore } from "../../services/auth-store";
export declare const AUDIT_LOG_FILENAME = "audit.log";
export declare const AUDIT_LOG_ROTATE_FILENAME = "audit.log.1";
export declare const AUDIT_LOG_MAX_BYTES: number;
export declare const AUDIT_REDACTION_RE: RegExp;
export interface AuditEventInput {
  actorIdentityId: string | null;
  ip: string | null;
  userAgent: string | null;
  action: string;
  outcome: "success" | "failure";
  metadata?: Record<string, string | number | boolean>;
}
export interface AuditEmitterOptions {
  store: AuthStore;
  env?: RuntimeEnvRecord;
  now?: () => number;
}
/**
 * Replace token-shaped runs in `metadata` with the literal `<redacted>` string.
 *
 * Only string values are scanned; numbers and booleans pass through unchanged.
 */
export declare function redactMetadata(
  metadata: Record<string, string | number | boolean>,
): Record<string, string | number | boolean>;
export declare function resolveAuditLogPath(env?: RuntimeEnvRecord): string;
export declare function resolveAuditLogRotatedPath(
  env?: RuntimeEnvRecord,
): string;
/**
 * Append an audit event to the database AND the JSONL log.
 *
 * Both writes are attempted. The first error is rethrown to the caller —
 * an audit-write failure is a real problem and should surface, not be
 * swallowed.
 */
export declare function appendAuditEvent(
  input: AuditEventInput,
  options: AuditEmitterOptions,
): Promise<void>;
//# sourceMappingURL=audit.d.ts.map
