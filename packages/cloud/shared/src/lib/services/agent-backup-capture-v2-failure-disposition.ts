/**
 * Trusted capture-v2 failure policy shared by the concrete executor and the
 * catalogue runtime. Only this module can brand a terminal disposition; raw
 * error fields from injected executors, abort reasons, or remote bodies never
 * authorize irreversible catalogue settlement or local spool cleanup.
 */

import { AgentBackupCaptureV2ProtocolError } from "@elizaos/shared";
import { AgentBackupCaptureV2HttpError } from "./agent-backup-capture-v2-client";
import { AgentBackupCaptureV2PipelineError } from "./agent-backup-capture-v2-pipeline";
import { AgentBackupCaptureV3SpoolError } from "./agent-backup-capture-v2-spool";
import { isResolvedAgentBackupCaptureV3RuntimeAuthorityStale } from "./agent-backup-capture-v3-runtime-context";
import type { AgentBackupCaptureV3TerminalSpoolCleanupAuthority } from "./agent-backup-capture-v3-spool-cleanup";

const TERMINAL_CAPTURE_FAILURE_CODES = new Set([
  "AGENT_BACKUP_V2_AUTHORITY_INVALID",
  "AGENT_BACKUP_V2_CAPTURE_ONLY_BOUNDARY_BROKEN",
  "AGENT_BACKUP_V2_CAPTURE_STATE",
  "AGENT_BACKUP_V2_CLAIM_AUTHORITY_INCOMPLETE",
  "AGENT_BACKUP_V2_CLAIM_AUTHORITY_INVALID",
  "AGENT_BACKUP_V2_CLAIM_CREATED_AT_INVALID",
  "AGENT_BACKUP_V2_AGENT_MISMATCH",
  "AGENT_BACKUP_V2_DIRECTORY_IDENTITY_INVALID",
  "AGENT_BACKUP_V2_FILE_CHANGED",
  "AGENT_BACKUP_V2_HTTP_AUTH_MISSING",
  "AGENT_BACKUP_V2_HTTP_CHUNK_TOO_LARGE",
  "AGENT_BACKUP_V2_HTTP_CONTENT_TYPE",
  "AGENT_BACKUP_V2_HTTP_FENCE_MISMATCH",
  "AGENT_BACKUP_V2_HTTP_OPERATION_MISMATCH",
  "AGENT_BACKUP_V2_HTTP_REDIRECT_REJECTED",
  "AGENT_BACKUP_V2_INVALID_REQUEST",
  "AGENT_BACKUP_V2_PGLITE_COMPONENT_OVERLAP",
  "AGENT_BACKUP_V2_PGLITE_DIRECTORY_MISMATCH",
  "AGENT_BACKUP_V2_PGLITE_DIRECTORY_UNATTESTED",
  "AGENT_BACKUP_V2_PGLITE_DUMP_ALREADY_CONSUMED",
  "AGENT_BACKUP_V2_PGLITE_DUMP_EXCEEDS_PREFLIGHT",
  "AGENT_BACKUP_V2_PGLITE_DUMP_NOT_STREAMABLE",
  "AGENT_BACKUP_V2_PGLITE_MANAGED_DUMP_UNAVAILABLE",
  "AGENT_BACKUP_V2_PGLITE_NOT_FILESYSTEM",
  "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
  "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_ENTRY_LIMIT",
  "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
  "AGENT_BACKUP_V2_PGLITE_STATE_OVERLAP",
  "AGENT_BACKUP_V2_POSTGRES_UNSUPPORTED",
  "AGENT_BACKUP_V2_RUNTIME_ATTESTATION_CHANGED",
  "AGENT_BACKUP_V2_RUNTIME_ATTESTATION_MISMATCH",
  "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
  "AGENT_BACKUP_V3_CATALOG_REPLAY_CONFLICT",
  "AGENT_BACKUP_V3_INCREMENTAL_CAPTURE_UNSUPPORTED",
  "AGENT_BACKUP_V3_KMS_AUTHORITY_INVALID",
  "AGENT_BACKUP_V3_SPOOL_INVENTORY_CONFLICT",
  "AGENT_BACKUP_V3_SPOOL_REPLAY_CONFLICT",
  "CAPTURE_V2_BAD_MAGIC",
  "CAPTURE_V2_CAPTURE_TOTALS",
  "CAPTURE_V2_CHAIN_DIGEST",
  "CAPTURE_V2_COMPONENT_DIGEST",
  "CAPTURE_V2_COMPONENT_ORDER",
  "CAPTURE_V2_COMPONENT_STATE",
  "CAPTURE_V2_COMPONENT_TOTALS",
  "CAPTURE_V2_CONTROL_FRAME_PAYLOAD",
  "CAPTURE_V2_DATA_FRAME_LIMIT",
  "CAPTURE_V2_DATA_STATE",
  "CAPTURE_V2_FILE_ENTRY_REQUIRED",
  "CAPTURE_V2_FILE_METADATA_DRIFT",
  "CAPTURE_V2_FILE_OFFSET",
  "CAPTURE_V2_FILE_ORDER",
  "CAPTURE_V2_FILE_SIZE_EXCEEDED",
  "CAPTURE_V2_FRAME_TAMPERED",
  "CAPTURE_V2_HEADER_LENGTH",
  "CAPTURE_V2_HEADER_TOO_LARGE",
  "CAPTURE_V2_INGRESS_CHUNK_TOO_LARGE",
  "CAPTURE_V2_INVALID_HEADER",
  "CAPTURE_V2_INVALID_HEADER_JSON",
  "CAPTURE_V2_INVALID_INGRESS_CHUNK",
  "CAPTURE_V2_KIND_MISMATCH",
  "CAPTURE_V2_PAYLOAD_LENGTH_MISMATCH",
  "CAPTURE_V2_PAYLOAD_TOO_LARGE",
  "CAPTURE_V2_PLAIN_BYTES_LIMIT",
  "CAPTURE_V2_SEQUENCE",
  "CAPTURE_V2_STATE",
  "CAPTURE_V2_TRAILING_BYTES",
  "CAPTURE_V2_TRUNCATED_FILE",
  "CAPTURE_V2_UNEXPECTED_FILE_ENTRY",
  "CAPTURE_V2_UNKNOWN_FRAME_KIND",
  "CAPTURE_V2_UNSUPPORTED_VERSION",
]);

const TRUSTED_TERMINAL_DISPOSITIONS = new WeakSet<AgentBackupCaptureV2CatalogExecutorError>();

export class AgentBackupCaptureV2CatalogExecutorError extends Error {
  override readonly name = "AgentBackupCaptureV2CatalogExecutorError";

  constructor(
    readonly code: string,
    message: string,
    options?: {
      cause?: unknown;
      terminal?: boolean;
      terminalSpoolCleanup?: AgentBackupCaptureV3TerminalSpoolCleanupAuthority;
    },
  ) {
    super(message, { cause: options?.cause });
    this.terminal = options?.terminal ?? false;
    this.terminalSpoolCleanup = options?.terminalSpoolCleanup;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  readonly terminal: boolean;
  readonly terminalSpoolCleanup: AgentBackupCaptureV3TerminalSpoolCleanupAuthority | undefined;
}

export function isTerminalAgentBackupCaptureV2FailureCode(code: string): boolean {
  return TERMINAL_CAPTURE_FAILURE_CODES.has(code);
}

export function isTrustedAgentBackupCaptureV2TerminalDisposition(
  error: unknown,
): error is AgentBackupCaptureV2CatalogExecutorError & { terminal: true } {
  return (
    error instanceof AgentBackupCaptureV2CatalogExecutorError &&
    error.terminal === true &&
    TRUSTED_TERMINAL_DISPOSITIONS.has(error)
  );
}

function trustedTerminalDisposition(params: {
  code: string;
  message: string;
  cause?: unknown;
  terminalSpoolCleanup?: AgentBackupCaptureV3TerminalSpoolCleanupAuthority;
}): AgentBackupCaptureV2CatalogExecutorError {
  const error = new AgentBackupCaptureV2CatalogExecutorError(params.code, params.message, {
    cause: params.cause,
    terminal: true,
    terminalSpoolCleanup: params.terminalSpoolCleanup,
  });
  TRUSTED_TERMINAL_DISPOSITIONS.add(error);
  return error;
}

/** Construct an executor-owned error, branding deterministic local policy only. */
export function createAgentBackupCaptureV2ExecutorError(
  code: string,
  message: string,
  cause?: unknown,
): AgentBackupCaptureV2CatalogExecutorError {
  return isTerminalAgentBackupCaptureV2FailureCode(code)
    ? trustedTerminalDisposition({ code, message, cause })
    : new AgentBackupCaptureV2CatalogExecutorError(code, message, { cause });
}

const CAUSE_BARRIER_CODES = new Set([
  "AGENT_BACKUP_V2_CAPTURE_ABORTED",
  "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
  "AGENT_BACKUP_V2_HTTP_ABORTED",
  "AGENT_BACKUP_V2_HTTP_DEADLINE_EXCEEDED",
  "AGENT_BACKUP_V2_PIPELINE_ABORTED",
  "AGENT_BACKUP_V2_PIPELINE_DEADLINE_EXCEEDED",
]);

function typedFailure(error: unknown): { code: string; message: string } | undefined {
  if (isTrustedAgentBackupCaptureV2TerminalDisposition(error)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof AgentBackupCaptureV2HttpError) {
    const code =
      error.code === "AGENT_BACKUP_V2_HTTP_STATUS" && error.remoteCode
        ? error.remoteCode
        : error.code;
    return { code, message: error.message };
  }
  if (
    error instanceof AgentBackupCaptureV2ProtocolError ||
    error instanceof AgentBackupCaptureV2PipelineError ||
    error instanceof AgentBackupCaptureV3SpoolError
  ) {
    return { code: error.code, message: error.message };
  }
  if (isResolvedAgentBackupCaptureV3RuntimeAuthorityStale(error)) {
    return { code: error.code, message: error.message };
  }
  return undefined;
}

function typedCause(error: unknown): unknown {
  if (
    error instanceof AgentBackupCaptureV2HttpError ||
    error instanceof AgentBackupCaptureV2ProtocolError ||
    error instanceof AgentBackupCaptureV2PipelineError ||
    error instanceof AgentBackupCaptureV3SpoolError
  ) {
    return CAUSE_BARRIER_CODES.has(error.code) ? undefined : error.cause;
  }
  return undefined;
}

/**
 * Normalize terminal evidence at the concrete executor boundary. Aggregate
 * containers may be generic, but only known typed leaves can affect policy.
 */
export function normalizeAgentBackupCaptureV2TerminalFailure(
  error: unknown,
  terminalSpoolCleanup?: AgentBackupCaptureV3TerminalSpoolCleanupAuthority,
): AgentBackupCaptureV2CatalogExecutorError | undefined {
  if (isTrustedAgentBackupCaptureV2TerminalDisposition(error)) {
    if (
      error.code === "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE" &&
      !error.terminalSpoolCleanup &&
      !terminalSpoolCleanup
    ) {
      return undefined;
    }
    if (terminalSpoolCleanup && !error.terminalSpoolCleanup) {
      return trustedTerminalDisposition({
        code: error.code,
        message: error.message,
        cause: error,
        terminalSpoolCleanup,
      });
    }
    return error;
  }

  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 32) {
    const current = pending.shift();
    if (!current || (typeof current !== "object" && typeof current !== "function")) continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const failure = typedFailure(current);
    const trustedRuntimeAuthorityStale =
      failure?.code === "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE" &&
      terminalSpoolCleanup !== undefined &&
      isResolvedAgentBackupCaptureV3RuntimeAuthorityStale(current);
    if (
      failure &&
      (isTerminalAgentBackupCaptureV2FailureCode(failure.code) || trustedRuntimeAuthorityStale)
    ) {
      return trustedTerminalDisposition({
        ...failure,
        cause: error,
        terminalSpoolCleanup,
      });
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
      if (current.cause !== undefined) pending.push(current.cause);
      continue;
    }
    const cause = typedCause(current);
    if (cause !== undefined) pending.push(cause);
  }
  return undefined;
}
