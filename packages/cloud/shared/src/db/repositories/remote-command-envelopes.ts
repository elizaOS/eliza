/**
 * Implements the opaque remote relay state machine on primary-database locks.
 * All mutation paths lock host, then session, then command; only a pre-start
 * claim lease may retry, while any post-start uncertainty becomes terminally
 * `execution_ambiguous` and is never returned to the queue.
 */

import { ElizaError } from "@elizaos/core/edge";
import {
  canonicalizeRemoteControlValue,
  type EncryptedRemoteCommandEnvelope,
  type EncryptedRemoteCommandResultEnvelope,
  type EncryptedRemoteCommandStartReceiptEnvelope,
  isEncryptedRemoteControlEnvelope,
  REMOTE_COMMAND_CLOCK_SKEW_MS,
  REMOTE_COMMAND_MAX_TTL_MS,
  REMOTE_CONTROL_MAX_REPLAY_ENTRIES_PER_SESSION,
} from "@elizaos/shared/contracts/remote-control";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../client";
import { hashRemoteHostToken } from "../crypto/remote-host-token";
import { dbWrite } from "../helpers";
import {
  type RemoteCommandEnvelope,
  remoteCommandEnvelopes,
  type StoredRemoteControlEnvelope,
} from "../schemas/remote-command-envelopes";
import { remoteHosts } from "../schemas/remote-hosts";
import { remoteSessions } from "../schemas/remote-sessions";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const MAX_CLAIM_LEASE_MS = 5 * 60_000;
const SESSION_EXPIRY_COMMAND_BATCH = 500;

export interface RemoteRelayScope {
  ownerId: string;
  grantId: string;
  grantRevision: number;
  sessionId: string;
  controllerDeviceId: string;
  controllerKeyId: string;
  targetRuntimeId: string;
  targetKeyId: string;
  commandId: string;
}

export type EnqueueRemoteCommandResult =
  | { kind: "queued"; command: RemoteCommandEnvelope }
  | { kind: "duplicate"; command: RemoteCommandEnvelope }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "replay" }
  | { kind: "sequence_gap" }
  | { kind: "session_capacity" };

export type ClaimRemoteCommandResult =
  | {
      kind: "claimed";
      command: RemoteCommandEnvelope;
      session: typeof remoteSessions.$inferSelect;
    }
  | { kind: "empty" }
  | { kind: "not_found" };

export type StartRemoteCommandResult =
  | { kind: "started" | "duplicate"; command: RemoteCommandEnvelope }
  | { kind: "not_found" }
  | { kind: "claim_lost" };

export type CompleteRemoteCommandResult =
  | { kind: "completed" | "duplicate"; command: RemoteCommandEnvelope }
  | { kind: "not_found" }
  | { kind: "claim_lost" }
  | { kind: "execution_ambiguous"; command: RemoteCommandEnvelope };

function invalidInput(message: string): ElizaError {
  return new ElizaError(message, {
    code: "REMOTE_RELAY_INVALID_INPUT",
    severity: "fatal",
  });
}

function storageFailure(message: string, context: Record<string, unknown>): ElizaError {
  return new ElizaError(message, {
    code: "REMOTE_RELAY_STORAGE_FAILURE",
    severity: "fatal",
    context,
  });
}

function sameEnvelope(
  left: StoredRemoteControlEnvelope | null,
  right: StoredRemoteControlEnvelope,
): boolean {
  return (
    left !== null && canonicalizeRemoteControlValue(left) === canonicalizeRemoteControlValue(right)
  );
}

function validateScope(scope: RemoteRelayScope): void {
  for (const [field, value] of Object.entries(scope).filter(([key]) => key !== "grantRevision")) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
      throw invalidInput(`${field} must contain 1-512 characters`);
    }
  }
  if (!Number.isSafeInteger(scope.grantRevision) || scope.grantRevision < 1) {
    throw invalidInput("grantRevision must be a positive safe integer");
  }
}

function validateSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw invalidInput("sequence must be a positive safe integer");
  }
}

function validateEnvelopeKind(
  envelope: StoredRemoteControlEnvelope,
  messageKind: StoredRemoteControlEnvelope["messageKind"],
): void {
  if (!isEncryptedRemoteControlEnvelope(envelope) || envelope.messageKind !== messageKind) {
    throw invalidInput(`envelope must be a valid ${messageKind} remote-control envelope`);
  }
  const targetOriginated = messageKind !== "command";
  if (
    envelope.senderKeyId !== (targetOriginated ? envelope.targetKeyId : envelope.controllerKeyId) ||
    envelope.recipientKeyId !== (targetOriginated ? envelope.controllerKeyId : envelope.targetKeyId)
  ) {
    throw invalidInput("envelope sender and recipient do not match its message kind");
  }
}

function envelopeMatchesCommand(
  envelope: StoredRemoteControlEnvelope,
  command: RemoteCommandEnvelope,
): boolean {
  return (
    envelope.ownerId === command.user_id &&
    envelope.grantId === command.grant_id &&
    envelope.grantRevision === command.grant_revision &&
    envelope.sessionId === command.session_id &&
    envelope.controllerDeviceId === command.controller_device_id &&
    envelope.controllerKeyId === command.controller_key_id &&
    envelope.targetRuntimeId === command.host_id &&
    envelope.targetKeyId === command.target_key_id &&
    envelope.commandId === command.command_id
  );
}

function validateClaim(input: { claimAttempt: number; claimToken: string }): void {
  if (!Number.isSafeInteger(input.claimAttempt) || input.claimAttempt < 1) {
    throw invalidInput("claimAttempt must be a positive safe integer");
  }
  if (typeof input.claimToken !== "string" || input.claimToken.length === 0) {
    throw invalidInput("claimToken is required");
  }
}

async function terminalizeSessionCommands(
  tx: DbTransaction,
  sessionId: string,
  now: Date,
  preStartStatus: "cancelled" | "expired",
): Promise<void> {
  const commands = await tx
    .select({ id: remoteCommandEnvelopes.id, status: remoteCommandEnvelopes.status })
    .from(remoteCommandEnvelopes)
    .where(
      and(
        eq(remoteCommandEnvelopes.session_id, sessionId),
        inArray(remoteCommandEnvelopes.status, ["pending", "claimed", "started"]),
      ),
    )
    .orderBy(asc(remoteCommandEnvelopes.sequence))
    .limit(SESSION_EXPIRY_COMMAND_BATCH)
    .for("update", { skipLocked: true });
  const preStartIds = commands
    .filter((command) => command.status !== "started")
    .map((command) => command.id);
  const startedIds = commands
    .filter((command) => command.status === "started")
    .map((command) => command.id);
  if (preStartIds.length > 0) {
    await tx
      .update(remoteCommandEnvelopes)
      .set({
        status: preStartStatus,
        claim_token: null,
        claim_expires_at: null,
        terminal_at: now,
        updated_at: now,
      })
      .where(inArray(remoteCommandEnvelopes.id, preStartIds));
  }
  if (startedIds.length > 0) {
    await tx
      .update(remoteCommandEnvelopes)
      .set({ status: "execution_ambiguous", terminal_at: now, updated_at: now })
      .where(inArray(remoteCommandEnvelopes.id, startedIds));
  }
}

export class RemoteCommandEnvelopesRepository {
  constructor(private readonly database: Database = dbWrite) {}

  async enqueue(input: {
    organizationId: string;
    ownerId: string;
    envelope: EncryptedRemoteCommandEnvelope;
  }): Promise<EnqueueRemoteCommandResult> {
    validateEnvelopeKind(input.envelope, "command");
    if (input.envelope.ownerId !== input.ownerId) {
      return { kind: "not_found" };
    }
    const scope: RemoteRelayScope = {
      ownerId: input.envelope.ownerId,
      grantId: input.envelope.grantId,
      grantRevision: input.envelope.grantRevision,
      sessionId: input.envelope.sessionId,
      controllerDeviceId: input.envelope.controllerDeviceId,
      controllerKeyId: input.envelope.controllerKeyId,
      targetRuntimeId: input.envelope.targetRuntimeId,
      targetKeyId: input.envelope.targetKeyId,
      commandId: input.envelope.commandId,
    };
    validateScope(scope);
    validateSequence(input.envelope.sequence);
    const expiresAt = new Date(input.envelope.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw invalidInput("envelope expiresAt is invalid");

    return this.database.transaction(async (tx) => {
      const [host] = await tx
        .select()
        .from(remoteHosts)
        .where(
          and(
            eq(remoteHosts.id, scope.targetRuntimeId),
            eq(remoteHosts.organization_id, input.organizationId),
            eq(remoteHosts.user_id, input.ownerId),
            eq(remoteHosts.status, "active"),
          ),
        )
        .for("update");
      if (!host || host.runtime_key_id !== scope.targetKeyId) return { kind: "not_found" };

      const [session] = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.id, scope.sessionId),
            eq(remoteSessions.grant_id, scope.grantId),
            eq(remoteSessions.grant_revision, scope.grantRevision),
            eq(remoteSessions.host_id, host.id),
            eq(remoteSessions.organization_id, input.organizationId),
            eq(remoteSessions.user_id, input.ownerId),
          ),
        )
        .for("update");
      if (
        !session ||
        session.controller_device_id !== scope.controllerDeviceId ||
        session.controller_key_id !== scope.controllerKeyId ||
        session.target_key_id !== scope.targetKeyId
      ) {
        return { kind: "not_found" };
      }

      const now = await readPostLockDatabaseNow(tx);
      if (session.status !== "active") {
        await terminalizeSessionCommands(
          tx,
          session.id,
          now,
          session.status === "expired" ? "expired" : "cancelled",
        );
        return session.status === "expired" ? { kind: "expired" } : { kind: "not_found" };
      }
      if (!session.grant_expires_at || session.grant_expires_at.getTime() <= now.getTime()) {
        await tx
          .update(remoteSessions)
          .set({ status: "expired", ended_at: now, updated_at: now })
          .where(and(eq(remoteSessions.id, session.id), eq(remoteSessions.status, "active")));
        await terminalizeSessionCommands(tx, session.id, now, "expired");
        return { kind: "expired" };
      }
      if (
        expiresAt.getTime() <= now.getTime() ||
        expiresAt.getTime() > session.grant_expires_at.getTime() ||
        input.envelope.issuedAt > now.getTime() + REMOTE_COMMAND_CLOCK_SKEW_MS ||
        input.envelope.expiresAt - input.envelope.issuedAt > REMOTE_COMMAND_MAX_TTL_MS
      ) {
        return { kind: "expired" };
      }
      if (input.envelope.sequence > REMOTE_CONTROL_MAX_REPLAY_ENTRIES_PER_SESSION) {
        return { kind: "session_capacity" };
      }

      const [existing] = await tx
        .select()
        .from(remoteCommandEnvelopes)
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, session.id),
            eq(remoteCommandEnvelopes.command_id, scope.commandId),
          ),
        )
        .limit(1);
      if (existing) {
        const duplicate =
          existing.sequence === input.envelope.sequence &&
          existing.nonce === input.envelope.nonce &&
          sameEnvelope(existing.envelope, input.envelope);
        return duplicate ? { kind: "duplicate", command: existing } : { kind: "replay" };
      }
      if (input.envelope.sequence <= session.last_sequence) return { kind: "replay" };
      if (input.envelope.sequence !== session.last_sequence + 1) return { kind: "sequence_gap" };

      const [command] = await tx
        .insert(remoteCommandEnvelopes)
        .values({
          session_id: session.id,
          grant_id: scope.grantId,
          grant_revision: scope.grantRevision,
          organization_id: input.organizationId,
          user_id: input.ownerId,
          host_id: host.id,
          controller_device_id: scope.controllerDeviceId,
          controller_key_id: scope.controllerKeyId,
          target_key_id: scope.targetKeyId,
          command_id: scope.commandId,
          sequence: input.envelope.sequence,
          nonce: input.envelope.nonce,
          envelope: input.envelope,
          expires_at: expiresAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!command) return { kind: "replay" };
      await tx
        .update(remoteSessions)
        .set({ last_sequence: input.envelope.sequence, updated_at: now })
        .where(eq(remoteSessions.id, session.id));
      return { kind: "queued", command };
    });
  }

  async claimNext(input: {
    sessionId: string;
    hostId: string;
    hostToken: string;
    leaseMs?: number;
  }): Promise<ClaimRemoteCommandResult> {
    const leaseMs = input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > MAX_CLAIM_LEASE_MS) {
      throw invalidInput("leaseMs must be between one second and five minutes");
    }
    let tokenHash: string;
    try {
      tokenHash = await hashRemoteHostToken(input.hostToken);
    } catch {
      // error-policy:J3 malformed bearer material is an explicit auth miss.
      return { kind: "not_found" };
    }

    return this.database.transaction(async (tx) => {
      const [host] = await tx
        .select()
        .from(remoteHosts)
        .where(
          and(
            eq(remoteHosts.id, input.hostId),
            eq(remoteHosts.host_token_hash, tokenHash),
            eq(remoteHosts.status, "active"),
          ),
        )
        .for("update");
      if (!host) return { kind: "not_found" };
      const now = await readPostLockDatabaseNow(tx);
      await tx
        .update(remoteHosts)
        .set({ last_seen_at: now, updated_at: now })
        .where(and(eq(remoteHosts.id, host.id), eq(remoteHosts.status, "active")));
      const [session] = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.id, input.sessionId),
            eq(remoteSessions.host_id, host.id),
            eq(remoteSessions.organization_id, host.organization_id),
            eq(remoteSessions.user_id, host.user_id),
          ),
        )
        .for("update");
      if (!session) return { kind: "not_found" };
      if (session.status !== "active") {
        await terminalizeSessionCommands(
          tx,
          session.id,
          now,
          session.status === "expired" ? "expired" : "cancelled",
        );
        return { kind: "not_found" };
      }
      if (!session.grant_expires_at || session.grant_expires_at.getTime() <= now.getTime()) {
        await tx
          .update(remoteSessions)
          .set({ status: "expired", ended_at: now, updated_at: now })
          .where(and(eq(remoteSessions.id, session.id), eq(remoteSessions.status, "active")));
        await terminalizeSessionCommands(tx, session.id, now, "expired");
        return { kind: "not_found" };
      }

      const staleStarted = await tx
        .select({ id: remoteCommandEnvelopes.id })
        .from(remoteCommandEnvelopes)
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, session.id),
            eq(remoteCommandEnvelopes.status, "started"),
            sql`${remoteCommandEnvelopes.expires_at} <= ${now}`,
          ),
        )
        .orderBy(asc(remoteCommandEnvelopes.sequence))
        .limit(100)
        .for("update", { skipLocked: true });
      if (staleStarted.length > 0) {
        await tx
          .update(remoteCommandEnvelopes)
          .set({ status: "execution_ambiguous", terminal_at: now, updated_at: now })
          .where(
            inArray(
              remoteCommandEnvelopes.id,
              staleStarted.map((command) => command.id),
            ),
          );
      }
      await tx
        .update(remoteCommandEnvelopes)
        .set({
          status: "pending",
          claim_token: null,
          claim_expires_at: null,
          updated_at: now,
        })
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, session.id),
            eq(remoteCommandEnvelopes.status, "claimed"),
            gt(remoteCommandEnvelopes.expires_at, now),
            sql`${remoteCommandEnvelopes.claim_expires_at} <= ${now}`,
          ),
        );
      await tx
        .update(remoteCommandEnvelopes)
        .set({
          status: "expired",
          claim_token: null,
          claim_expires_at: null,
          terminal_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, session.id),
            inArray(remoteCommandEnvelopes.status, ["pending", "claimed"]),
            sql`${remoteCommandEnvelopes.expires_at} <= ${now}`,
          ),
        );

      const [candidate] = await tx
        .select()
        .from(remoteCommandEnvelopes)
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, session.id),
            eq(remoteCommandEnvelopes.host_id, host.id),
            eq(remoteCommandEnvelopes.status, "pending"),
            gt(remoteCommandEnvelopes.expires_at, now),
          ),
        )
        .orderBy(asc(remoteCommandEnvelopes.sequence))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return { kind: "empty" };

      const claimToken = crypto.randomUUID();
      const claimExpiresAt = new Date(
        Math.min(now.getTime() + leaseMs, candidate.expires_at.getTime()),
      );
      const [claimed] = await tx
        .update(remoteCommandEnvelopes)
        .set({
          status: "claimed",
          attempts: sql`${remoteCommandEnvelopes.attempts} + 1`,
          claim_token: claimToken,
          claim_expires_at: claimExpiresAt,
          updated_at: now,
        })
        .where(
          and(
            eq(remoteCommandEnvelopes.id, candidate.id),
            eq(remoteCommandEnvelopes.status, "pending"),
          ),
        )
        .returning();
      if (!claimed) {
        throw storageFailure("Locked remote command could not be claimed", {
          commandId: candidate.command_id,
        });
      }
      return { kind: "claimed", command: claimed, session };
    });
  }

  async recordStart(input: {
    sessionId: string;
    commandId: string;
    hostId: string;
    hostToken: string;
    claimAttempt: number;
    claimToken: string;
    startReceipt: EncryptedRemoteCommandStartReceiptEnvelope;
  }): Promise<StartRemoteCommandResult> {
    validateClaim(input);
    validateEnvelopeKind(input.startReceipt, "start_receipt");
    return this.withHostSessionCommand(input, async ({ tx, command, now }) => {
      if (!envelopeMatchesCommand(input.startReceipt, command)) return { kind: "not_found" };
      if (
        command.status === "started" &&
        command.claim_token === input.claimToken &&
        command.attempts === input.claimAttempt &&
        sameEnvelope(command.start_receipt, input.startReceipt)
      ) {
        return { kind: "duplicate", command };
      }
      if (
        command.status !== "claimed" ||
        command.claim_token !== input.claimToken ||
        command.attempts !== input.claimAttempt ||
        !command.claim_expires_at ||
        command.claim_expires_at.getTime() <= now.getTime() ||
        command.expires_at.getTime() <= now.getTime()
      ) {
        return { kind: "claim_lost" };
      }
      const [started] = await tx
        .update(remoteCommandEnvelopes)
        .set({
          status: "started",
          start_receipt: input.startReceipt,
          started_at: now,
          claim_expires_at: null,
          updated_at: now,
        })
        .where(
          and(
            eq(remoteCommandEnvelopes.id, command.id),
            eq(remoteCommandEnvelopes.status, "claimed"),
            eq(remoteCommandEnvelopes.claim_token, input.claimToken),
            eq(remoteCommandEnvelopes.attempts, input.claimAttempt),
          ),
        )
        .returning();
      if (!started) return { kind: "claim_lost" };
      return { kind: "started", command: started };
    });
  }

  async complete(input: {
    sessionId: string;
    commandId: string;
    hostId: string;
    hostToken: string;
    claimAttempt: number;
    claimToken: string;
    resultEnvelope: EncryptedRemoteCommandResultEnvelope;
  }): Promise<CompleteRemoteCommandResult> {
    validateClaim(input);
    validateEnvelopeKind(input.resultEnvelope, "result");
    return this.withHostSessionCommand(input, async ({ tx, command, now }) => {
      if (!envelopeMatchesCommand(input.resultEnvelope, command)) return { kind: "not_found" };
      if (
        command.status === "completed" &&
        command.claim_token === input.claimToken &&
        command.attempts === input.claimAttempt &&
        sameEnvelope(command.result_envelope, input.resultEnvelope)
      ) {
        return { kind: "duplicate", command };
      }
      if (
        command.status !== "started" ||
        command.claim_token !== input.claimToken ||
        command.attempts !== input.claimAttempt ||
        !command.start_receipt
      ) {
        return { kind: "claim_lost" };
      }
      if (command.expires_at.getTime() <= now.getTime()) {
        const [ambiguous] = await tx
          .update(remoteCommandEnvelopes)
          .set({ status: "execution_ambiguous", terminal_at: now, updated_at: now })
          .where(
            and(
              eq(remoteCommandEnvelopes.id, command.id),
              eq(remoteCommandEnvelopes.status, "started"),
            ),
          )
          .returning();
        if (!ambiguous) return { kind: "claim_lost" };
        return { kind: "execution_ambiguous", command: ambiguous };
      }
      const [completed] = await tx
        .update(remoteCommandEnvelopes)
        .set({
          status: "completed",
          result_envelope: input.resultEnvelope,
          completed_at: now,
          terminal_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(remoteCommandEnvelopes.id, command.id),
            eq(remoteCommandEnvelopes.status, "started"),
            eq(remoteCommandEnvelopes.claim_token, input.claimToken),
            eq(remoteCommandEnvelopes.attempts, input.claimAttempt),
          ),
        )
        .returning();
      if (!completed) return { kind: "claim_lost" };
      return { kind: "completed", command: completed };
    });
  }

  async readOwnedResult(input: {
    organizationId: string;
    ownerId: string;
    sessionId: string;
    commandId: string;
  }): Promise<RemoteCommandEnvelope | undefined> {
    const [row] = await this.database
      .select({ command: remoteCommandEnvelopes })
      .from(remoteCommandEnvelopes)
      .innerJoin(
        remoteSessions,
        and(
          eq(remoteSessions.id, remoteCommandEnvelopes.session_id),
          eq(remoteSessions.organization_id, remoteCommandEnvelopes.organization_id),
          eq(remoteSessions.user_id, remoteCommandEnvelopes.user_id),
        ),
      )
      .where(
        and(
          eq(remoteCommandEnvelopes.session_id, input.sessionId),
          eq(remoteCommandEnvelopes.command_id, input.commandId),
          eq(remoteCommandEnvelopes.organization_id, input.organizationId),
          eq(remoteCommandEnvelopes.user_id, input.ownerId),
        ),
      )
      .limit(1);
    return row?.command;
  }

  private async withHostSessionCommand<T>(
    input: {
      sessionId: string;
      commandId: string;
      hostId: string;
      hostToken: string;
    },
    callback: (context: {
      tx: DbTransaction;
      command: RemoteCommandEnvelope;
      now: Date;
    }) => Promise<T>,
  ): Promise<T | { kind: "not_found" }> {
    let tokenHash: string;
    try {
      tokenHash = await hashRemoteHostToken(input.hostToken);
    } catch {
      // error-policy:J3 malformed bearer material is an explicit auth miss.
      return { kind: "not_found" };
    }
    return this.database.transaction(async (tx) => {
      const [host] = await tx
        .select()
        .from(remoteHosts)
        .where(
          and(
            eq(remoteHosts.id, input.hostId),
            eq(remoteHosts.host_token_hash, tokenHash),
            eq(remoteHosts.status, "active"),
          ),
        )
        .for("update");
      if (!host) return { kind: "not_found" };
      const [session] = await tx
        .select({
          id: remoteSessions.id,
          status: remoteSessions.status,
          grantExpiresAt: remoteSessions.grant_expires_at,
        })
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.id, input.sessionId),
            eq(remoteSessions.host_id, host.id),
            eq(remoteSessions.organization_id, host.organization_id),
            eq(remoteSessions.user_id, host.user_id),
          ),
        )
        .for("update");
      if (!session) return { kind: "not_found" };
      const now = await readPostLockDatabaseNow(tx);
      if (
        session.status !== "active" ||
        !session.grantExpiresAt ||
        session.grantExpiresAt.getTime() <= now.getTime()
      ) {
        if (session.status === "active") {
          await tx
            .update(remoteSessions)
            .set({ status: "expired", ended_at: now, updated_at: now })
            .where(and(eq(remoteSessions.id, session.id), eq(remoteSessions.status, "active")));
        }
        await terminalizeSessionCommands(
          tx,
          session.id,
          now,
          session.status === "active" || session.status === "expired" ? "expired" : "cancelled",
        );
        return { kind: "not_found" };
      }
      const [command] = await tx
        .select()
        .from(remoteCommandEnvelopes)
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, session.id),
            eq(remoteCommandEnvelopes.command_id, input.commandId),
            eq(remoteCommandEnvelopes.host_id, host.id),
            eq(remoteCommandEnvelopes.organization_id, host.organization_id),
            eq(remoteCommandEnvelopes.user_id, host.user_id),
          ),
        )
        .for("update");
      if (!command) return { kind: "not_found" };
      return callback({ tx, command, now });
    });
  }
}

export const remoteCommandEnvelopesRepository = new RemoteCommandEnvelopesRepository();
