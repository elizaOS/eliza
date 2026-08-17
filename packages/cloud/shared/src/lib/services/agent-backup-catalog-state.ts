/** Pure transition and validation rules for the v2 backup catalogue. */

import type { AgentBackupCatalogState } from "../../db/schemas/agent-sandboxes";

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_ERROR_CODE_LENGTH = 96;
const MAX_ERROR_MESSAGE_LENGTH = 2_048;
const MAX_IDENTITY_LENGTH = 512;

const DIRECT_TRANSITIONS: Readonly<
  Record<AgentBackupCatalogState, readonly AgentBackupCatalogState[]>
> = {
  legacy_unmigrated: ["retained", "expiration_pending", "failed_terminal"],
  scheduled: ["capturing", "failed_retryable", "failed_terminal"],
  capturing: ["captured", "failed_retryable", "failed_terminal"],
  captured: ["uploading", "failed_retryable", "failed_terminal"],
  uploading: ["primary_uploaded", "failed_retryable", "failed_terminal"],
  primary_uploaded: ["primary_verified", "failed_retryable", "failed_terminal"],
  primary_verified: ["secondary_pending", "failed_retryable", "failed_terminal"],
  secondary_pending: ["protected", "failed_retryable", "failed_terminal"],
  protected: ["retained", "restore_verified", "expiration_pending", "failed_terminal"],
  retained: ["restore_verified", "expiration_pending", "failed_terminal"],
  restore_verified: ["retained", "expiration_pending", "failed_terminal"],
  expiration_pending: ["deleting", "retained", "failed_retryable", "failed_terminal"],
  deleting: ["deleted", "failed_retryable", "failed_terminal"],
  deleted: [],
  failed_retryable: [],
  failed_terminal: [],
};

export interface AgentBackupCatalogTransition {
  from: AgentBackupCatalogState;
  to: AgentBackupCatalogState;
  /** Required when entering a failure state or leaving `failed_retryable`. */
  resumeState?: AgentBackupCatalogState | null;
}

export function isSha256Hex(value: string): boolean {
  return SHA256_RE.test(value);
}

export function requireSha256Hex(value: string, field: string): string {
  if (!isSha256Hex(value)) throw new Error(`${field} must be a lowercase SHA-256 hex digest`);
  return value;
}

export function requireBoundedIdentity(value: string, field: string): string {
  if (value.length === 0 || value.length > MAX_IDENTITY_LENGTH) {
    throw new Error(`${field} must contain 1-${MAX_IDENTITY_LENGTH} characters`);
  }
  if (/^\s|\s$/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be canonical and contain no control characters`);
  }
  return value;
}

export function boundedBackupCatalogError(error: { code: string; message: string }): {
  code: string;
  message: string;
} {
  const canonicalCode = error.code.trim();
  if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(canonicalCode)) {
    throw new Error(`Backup catalogue error code must match ^[A-Z][A-Z0-9_]{0,95}$`);
  }
  const message = error.message
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
  if (message.length === 0) throw new Error("Backup catalogue error message cannot be empty");
  return { code: canonicalCode.slice(0, MAX_ERROR_CODE_LENGTH), message };
}

/**
 * Enforces the durable state machine, including retry resumption. A retryable
 * failure records the exact state to re-enter; callers cannot use it as a
 * shortcut around verification or secondary replication.
 */
export function assertAgentBackupCatalogTransition(transition: AgentBackupCatalogTransition): void {
  if (transition.from === transition.to) return;

  if (transition.from === "failed_retryable") {
    if (!transition.resumeState || transition.to !== transition.resumeState) {
      throw new Error("A retryable backup operation may only resume its recorded state");
    }
    if (
      transition.to === "legacy_unmigrated" ||
      transition.to === "failed_retryable" ||
      transition.to === "failed_terminal" ||
      transition.to === "deleted"
    ) {
      throw new Error(`Invalid retry resume state: ${transition.to}`);
    }
    return;
  }

  const allowed = DIRECT_TRANSITIONS[transition.from];
  if (!allowed.includes(transition.to)) {
    throw new Error(`Invalid backup catalogue transition: ${transition.from} -> ${transition.to}`);
  }

  if (transition.to === "failed_retryable" || transition.to === "failed_terminal") {
    if (!transition.resumeState || transition.resumeState !== transition.from) {
      throw new Error("Entering a failure state must preserve the exact state that failed");
    }
  } else if (transition.resumeState != null) {
    throw new Error("resumeState is only valid for backup failure transitions");
  }
}

export function catalogStateRequiresManifest(state: AgentBackupCatalogState): boolean {
  return (
    state === "captured" ||
    state === "uploading" ||
    state === "primary_uploaded" ||
    state === "primary_verified" ||
    state === "secondary_pending" ||
    state === "protected" ||
    state === "retained" ||
    state === "expiration_pending" ||
    state === "deleting" ||
    state === "deleted" ||
    state === "restore_verified"
  );
}

export function catalogStateAllowsRestore(state: AgentBackupCatalogState): boolean {
  return (
    state === "primary_verified" ||
    state === "secondary_pending" ||
    state === "protected" ||
    state === "retained" ||
    state === "restore_verified"
  );
}
