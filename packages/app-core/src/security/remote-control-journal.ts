/**
 * Defines and exercises the durable exactly-once dispatch boundary for remote
 * commands. Authority mutation, replay consumption, command reservation, and
 * execution transitions share one serialization boundary so revocation cannot
 * race command admission and a post-start crash is surfaced as ambiguous.
 */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  canonicalizeRemoteControlValue,
  isRemoteControllerGrant,
  REMOTE_CONTROL_MAX_ACTIVE_SESSIONS,
  REMOTE_CONTROL_MAX_REPLAY_ENTRIES_PER_SESSION,
  type RemoteCommandBinding,
  type RemoteCommandResultStatus,
  type RemoteControllerGrant,
  type RemoteJsonValue,
  type SignedRemoteCommand,
} from "@elizaos/shared";

export type RemoteCommandJournalStatus =
  | "reserved"
  | "started"
  | RemoteCommandResultStatus;

export interface RemoteCommandJournalRecord extends RemoteCommandBinding {
  commandDigest: string;
  sequence: number;
  nonce: string;
  expiresAt: number;
  status: RemoteCommandJournalStatus;
  reservedAt: number;
  executionId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  resultDigest: string | null;
  errorCode: string | null;
}

export type RemoteCommandAdmissionRejection =
  | "unknown_grant"
  | "revoked"
  | "expired"
  | "wrong_owner"
  | "wrong_session"
  | "wrong_controller"
  | "wrong_target"
  | "stale_grant"
  | "replay"
  | "command_digest_mismatch"
  | "command_conflict"
  | "capacity";

export type RemoteCommandAdmission =
  | {
      ok: true;
      disposition: "reserved" | "duplicate";
      record: RemoteCommandJournalRecord;
    }
  | { ok: false; reason: RemoteCommandAdmissionRejection };

export type RemoteCommandStart =
  | { ok: true; disposition: "started"; record: RemoteCommandJournalRecord }
  | {
      ok: true;
      disposition: "already_started" | "terminal";
      record: RemoteCommandJournalRecord;
    }
  | { ok: false; reason: "not_found" };

export interface CompleteRemoteCommandInput {
  commandId: string;
  executionId: string;
  status: RemoteCommandResultStatus;
  completedAt: number;
  resultDigest: string;
  errorCode?: string;
}

export type RemoteCommandCompletion =
  | {
      ok: true;
      disposition: "completed" | "duplicate";
      record: RemoteCommandJournalRecord;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_started"
        | "execution_conflict"
        | "result_conflict";
    };

export interface RemoteCommandSessionTermination {
  sessionId: string;
  terminatedAt: number;
  reservedRejected: number;
  startedAmbiguous: number;
  replayEntriesDeleted: number;
  authoritiesRevoked: number;
}

export interface DurableRemoteCommandJournal {
  /** Serializes an authority create/update/revoke with command admission. */
  installAuthority(grant: RemoteControllerGrant): Promise<void>;
  /**
   * Atomically re-reads current authority, rejects revocation/expiry, consumes
   * nonce+sequence, and reserves the command ID. This is the replay boundary;
   * callers must never consume replay state before this method.
   */
  authorizeAndReserve(input: {
    command: SignedRemoteCommand;
    commandDigest: string;
    now: number;
  }): Promise<RemoteCommandAdmission>;
  /** Durably writes the start receipt before invoking the external effect. */
  beginExecution(
    commandId: string,
    startedAt: number,
  ): Promise<RemoteCommandStart>;
  /** Idempotently records one terminal outcome for the matching execution. */
  completeExecution(
    input: CompleteRemoteCommandInput,
  ): Promise<RemoteCommandCompletion>;
  /** Converts orphaned starts to explicit ambiguity; it never retries them. */
  recoverInterruptedExecutions(
    recoveredAt: number,
  ): Promise<RemoteCommandJournalRecord[]>;
  /** Clears replay state and fences all nonterminal work for a dead session. */
  terminateSession(
    sessionId: string,
    terminatedAt: number,
  ): Promise<RemoteCommandSessionTermination>;
  get(commandId: string): Promise<RemoteCommandJournalRecord | null>;
}

interface SessionReplayState {
  ownerId: string;
  controllerDeviceId: string;
  lastSequence: number;
  nonces: Map<string, number>;
}

function remoteJournalError(
  message: string,
  code: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    cause,
    context,
    severity: "fatal",
  });
}

function copyRecord(
  record: RemoteCommandJournalRecord,
): RemoteCommandJournalRecord {
  return { ...record };
}

function digestJournalValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeRemoteControlValue(value))
    .digest("base64url");
}

function sameBinding(
  record: RemoteCommandJournalRecord,
  command: SignedRemoteCommand,
): boolean {
  const body = command.body;
  return (
    record.version === body.version &&
    record.ownerId === body.ownerId &&
    record.grantId === body.grantId &&
    record.grantRevision === body.grantRevision &&
    record.sessionId === body.sessionId &&
    record.controllerDeviceId === body.controllerDeviceId &&
    record.controllerKeyId === body.controllerKeyId &&
    record.targetRuntimeId === body.targetRuntimeId &&
    record.targetKeyId === body.targetKeyId &&
    record.commandId === body.commandId &&
    record.sequence === body.sequence &&
    record.nonce === body.nonce
  );
}

/** Deterministic in-memory reference implementation of the durable interface. */
export class InMemoryDurableRemoteCommandJournal
  implements DurableRemoteCommandJournal
{
  private readonly authorities = new Map<string, RemoteControllerGrant>();
  private readonly sessions = new Map<string, SessionReplayState>();
  private readonly records = new Map<string, RemoteCommandJournalRecord>();
  private transactionTail: Promise<void> = Promise.resolve();

  private transact<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.transactionTail.then(operation, operation);
    this.transactionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async installAuthority(grant: RemoteControllerGrant): Promise<void> {
    return this.transact(() => {
      if (!isRemoteControllerGrant(grant)) {
        throw remoteJournalError(
          "Remote authority is malformed",
          "REMOTE_AUTHORITY_MALFORMED",
        );
      }
      const current = this.authorities.get(grant.grantId);
      if (current && grant.revision < current.revision) {
        throw remoteJournalError(
          "Remote authority revision cannot move backward",
          "REMOTE_AUTHORITY_REVISION_REGRESSION",
          { grantId: grant.grantId },
        );
      }
      if (
        current?.revokedAt !== null &&
        current?.revokedAt !== undefined &&
        grant.revokedAt === null
      ) {
        throw remoteJournalError(
          "Remote authority revocation cannot be reversed",
          "REMOTE_AUTHORITY_REVOCATION_REVERSAL",
          { grantId: grant.grantId },
        );
      }
      if (
        current &&
        grant.revision === current.revision &&
        canonicalizeRemoteControlValue(current) !==
          canonicalizeRemoteControlValue(grant)
      ) {
        throw remoteJournalError(
          "Remote authority revision cannot be replaced",
          "REMOTE_AUTHORITY_REVISION_CONFLICT",
          { grantId: grant.grantId },
        );
      }
      this.authorities.set(grant.grantId, {
        ...grant,
        targetRuntimeIds: [...grant.targetRuntimeIds],
      });
    });
  }

  async authorizeAndReserve(input: {
    command: SignedRemoteCommand;
    commandDigest: string;
    now: number;
  }): Promise<RemoteCommandAdmission> {
    return this.transact(() => {
      const body = input.command.body;
      if (digestJournalValue(body) !== input.commandDigest) {
        return { ok: false, reason: "command_digest_mismatch" };
      }
      const authority = this.authorities.get(body.grantId);
      if (!authority) return { ok: false, reason: "unknown_grant" };
      if (authority.revision !== body.grantRevision) {
        return { ok: false, reason: "stale_grant" };
      }
      if (
        authority.revokedAt !== null ||
        (authority.expiresAt !== null && authority.expiresAt < input.now)
      ) {
        return { ok: false, reason: "revoked" };
      }
      if (body.expiresAt < input.now) return { ok: false, reason: "expired" };
      if (authority.ownerId !== body.ownerId) {
        return { ok: false, reason: "wrong_owner" };
      }
      if (authority.sessionId !== body.sessionId) {
        return { ok: false, reason: "wrong_session" };
      }
      if (
        authority.controllerDeviceId !== body.controllerDeviceId ||
        authority.controllerKeyId !== body.controllerKeyId
      ) {
        return { ok: false, reason: "wrong_controller" };
      }
      if (!authority.targetRuntimeIds.includes(body.targetRuntimeId)) {
        return { ok: false, reason: "wrong_target" };
      }

      const existing = this.records.get(body.commandId);
      if (existing) {
        if (
          existing.commandDigest !== input.commandDigest ||
          !sameBinding(existing, input.command)
        ) {
          return { ok: false, reason: "command_conflict" };
        }
        return {
          ok: true,
          disposition: "duplicate",
          record: copyRecord(existing),
        };
      }

      let session = this.sessions.get(body.sessionId);
      if (!session) {
        if (this.sessions.size >= REMOTE_CONTROL_MAX_ACTIVE_SESSIONS) {
          return { ok: false, reason: "capacity" };
        }
        session = {
          ownerId: body.ownerId,
          controllerDeviceId: body.controllerDeviceId,
          lastSequence: 0,
          nonces: new Map(),
        };
        this.sessions.set(body.sessionId, session);
      }
      if (
        session.ownerId !== body.ownerId ||
        session.controllerDeviceId !== body.controllerDeviceId
      ) {
        return { ok: false, reason: "wrong_session" };
      }
      for (const [nonce, expiresAt] of session.nonces) {
        if (expiresAt < input.now) session.nonces.delete(nonce);
      }
      if (
        session.nonces.has(body.nonce) ||
        body.sequence <= session.lastSequence
      ) {
        return { ok: false, reason: "replay" };
      }
      if (
        session.nonces.size >= REMOTE_CONTROL_MAX_REPLAY_ENTRIES_PER_SESSION
      ) {
        return { ok: false, reason: "capacity" };
      }

      const record: RemoteCommandJournalRecord = {
        version: body.version,
        ownerId: body.ownerId,
        grantId: body.grantId,
        grantRevision: body.grantRevision,
        sessionId: body.sessionId,
        controllerDeviceId: body.controllerDeviceId,
        controllerKeyId: body.controllerKeyId,
        targetRuntimeId: body.targetRuntimeId,
        targetKeyId: body.targetKeyId,
        commandId: body.commandId,
        commandDigest: input.commandDigest,
        sequence: body.sequence,
        nonce: body.nonce,
        expiresAt: body.expiresAt,
        status: "reserved",
        reservedAt: input.now,
        executionId: null,
        startedAt: null,
        completedAt: null,
        resultDigest: null,
        errorCode: null,
      };
      session.lastSequence = body.sequence;
      session.nonces.set(body.nonce, body.expiresAt);
      this.records.set(body.commandId, record);
      return { ok: true, disposition: "reserved", record: copyRecord(record) };
    });
  }

  async beginExecution(
    commandId: string,
    startedAt: number,
  ): Promise<RemoteCommandStart> {
    return this.transact(() => {
      const record = this.records.get(commandId);
      if (!record) return { ok: false, reason: "not_found" };
      if (record.status === "started") {
        return {
          ok: true,
          disposition: "already_started",
          record: copyRecord(record),
        };
      }
      if (record.status !== "reserved") {
        return {
          ok: true,
          disposition: "terminal",
          record: copyRecord(record),
        };
      }
      record.status = "started";
      record.executionId = randomUUID();
      record.startedAt = startedAt;
      return { ok: true, disposition: "started", record: copyRecord(record) };
    });
  }

  async completeExecution(
    input: CompleteRemoteCommandInput,
  ): Promise<RemoteCommandCompletion> {
    return this.transact(() => {
      const record = this.records.get(input.commandId);
      if (!record) return { ok: false, reason: "not_found" };
      if (record.executionId !== input.executionId) {
        return { ok: false, reason: "execution_conflict" };
      }
      if (record.status !== "started") {
        if (
          record.status === input.status &&
          record.resultDigest === input.resultDigest &&
          record.errorCode === (input.errorCode ?? null)
        ) {
          return {
            ok: true,
            disposition: "duplicate",
            record: copyRecord(record),
          };
        }
        return { ok: false, reason: "result_conflict" };
      }
      record.status = input.status;
      record.completedAt = input.completedAt;
      record.resultDigest = input.resultDigest;
      record.errorCode = input.errorCode ?? null;
      return { ok: true, disposition: "completed", record: copyRecord(record) };
    });
  }

  async recoverInterruptedExecutions(
    recoveredAt: number,
  ): Promise<RemoteCommandJournalRecord[]> {
    return this.transact(() => {
      const recovered: RemoteCommandJournalRecord[] = [];
      for (const record of this.records.values()) {
        if (record.status !== "started") continue;
        record.status = "execution_ambiguous";
        record.completedAt = recoveredAt;
        record.resultDigest = digestJournalValue({
          errorCode: "REMOTE_EXECUTION_INTERRUPTED",
        });
        record.errorCode = "REMOTE_EXECUTION_INTERRUPTED";
        recovered.push(copyRecord(record));
      }
      return recovered;
    });
  }

  async terminateSession(
    sessionId: string,
    terminatedAt: number,
  ): Promise<RemoteCommandSessionTermination> {
    return this.transact(() => {
      const session = this.sessions.get(sessionId);
      const replayEntriesDeleted = session?.nonces.size ?? 0;
      this.sessions.delete(sessionId);
      let authoritiesRevoked = 0;
      for (const [grantId, authority] of this.authorities) {
        if (authority.sessionId !== sessionId || authority.revokedAt !== null) {
          continue;
        }
        authoritiesRevoked += 1;
        this.authorities.set(grantId, {
          ...authority,
          revision: authority.revision + 1,
          revokedAt: terminatedAt,
        });
      }
      let reservedRejected = 0;
      let startedAmbiguous = 0;
      for (const record of this.records.values()) {
        if (record.sessionId !== sessionId) continue;
        if (record.status === "reserved") {
          reservedRejected += 1;
          record.status = "rejected";
          record.completedAt = terminatedAt;
          record.resultDigest = digestJournalValue({
            errorCode: "REMOTE_SESSION_TERMINATED",
          });
          record.errorCode = "REMOTE_SESSION_TERMINATED";
        } else if (record.status === "started") {
          startedAmbiguous += 1;
          record.status = "execution_ambiguous";
          record.completedAt = terminatedAt;
          record.resultDigest = digestJournalValue({
            errorCode: "REMOTE_SESSION_TERMINATED_AFTER_START",
          });
          record.errorCode = "REMOTE_SESSION_TERMINATED_AFTER_START";
        }
      }
      return {
        sessionId,
        terminatedAt,
        reservedRejected,
        startedAmbiguous,
        replayEntriesDeleted,
        authoritiesRevoked,
      };
    });
  }

  async get(commandId: string): Promise<RemoteCommandJournalRecord | null> {
    return this.transact(() => {
      const record = this.records.get(commandId);
      return record ? copyRecord(record) : null;
    });
  }
}

export interface RemoteCommandEffectOutcome {
  status: Exclude<RemoteCommandResultStatus, "execution_ambiguous">;
  result?: RemoteJsonValue;
  errorCode?: string;
  resultDigest: string;
}

export type RemoteCommandExecutionOutcome =
  | {
      disposition: "completed";
      record: RemoteCommandJournalRecord;
      effect: RemoteCommandEffectOutcome;
    }
  | {
      disposition: "already_started" | "terminal";
      record: RemoteCommandJournalRecord;
    }
  | { disposition: "not_found" };

/**
 * Writes start before invoking the effect and never invokes it for an existing
 * start. The effect must use `executionId` as its durable idempotency key when
 * it commits in another storage system; otherwise a cross-system crash is
 * necessarily reported as `execution_ambiguous` rather than retried.
 */
export async function executeReservedRemoteCommand(
  journal: DurableRemoteCommandJournal,
  input: {
    commandId: string;
    startedAt: number;
    completedAt: () => number;
    effect: (executionId: string) => Promise<RemoteCommandEffectOutcome>;
  },
): Promise<RemoteCommandExecutionOutcome> {
  const started = await journal.beginExecution(
    input.commandId,
    input.startedAt,
  );
  if (!started.ok) return { disposition: "not_found" };
  if (started.disposition !== "started") {
    return { disposition: started.disposition, record: started.record };
  }
  const executionId = started.record.executionId;
  if (!executionId) {
    throw remoteJournalError(
      "Durable remote start did not allocate an execution ID",
      "REMOTE_EXECUTION_ID_MISSING",
      { commandId: input.commandId },
    );
  }
  let effect: RemoteCommandEffectOutcome;
  try {
    effect = await input.effect(executionId);
  } catch (cause) {
    // error-policy:J1 an effect that throws after durable start has unknown commit state.
    const ambiguous = await journal.completeExecution({
      commandId: input.commandId,
      executionId,
      status: "execution_ambiguous",
      completedAt: input.completedAt(),
      resultDigest: digestJournalValue({
        errorCode: "REMOTE_EFFECT_OUTCOME_UNKNOWN",
      }),
      errorCode: "REMOTE_EFFECT_OUTCOME_UNKNOWN",
    });
    if (!ambiguous.ok) {
      throw remoteJournalError(
        "Could not persist ambiguous remote execution",
        "REMOTE_AMBIGUOUS_RESULT_PERSIST_FAILED",
        { commandId: input.commandId },
        cause,
      );
    }
    return { disposition: "terminal", record: ambiguous.record };
  }
  const completed = await journal.completeExecution({
    commandId: input.commandId,
    executionId,
    status: effect.status,
    completedAt: input.completedAt(),
    resultDigest: effect.resultDigest,
    errorCode: effect.errorCode,
  });
  if (!completed.ok) {
    throw remoteJournalError(
      `Could not persist remote command result: ${completed.reason}`,
      "REMOTE_RESULT_PERSIST_FAILED",
      { commandId: input.commandId, reason: completed.reason },
    );
  }
  return { disposition: "completed", record: completed.record, effect };
}
