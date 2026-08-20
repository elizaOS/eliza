/** Durable opaque relay with controller sequence and host claim-lease enforcement. */

import type { EncryptedRemoteCommand } from "@elizaos/shared";
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { dbWrite } from "../helpers";
import {
  type RemoteCommandEnvelope,
  remoteCommandEnvelopes,
} from "../schemas/remote-command-envelopes";
import { remoteHosts } from "../schemas/remote-hosts";
import { remoteSessions } from "../schemas/remote-sessions";

const CLAIM_LEASE_MS = 30_000;

export type EnqueueRemoteCommandResult =
  | { kind: "queued"; command: RemoteCommandEnvelope }
  | { kind: "not_found" }
  | { kind: "replay" }
  | { kind: "wrong_keys" };

export interface ClaimedRemoteCommand {
  command: RemoteCommandEnvelope;
  session: typeof remoteSessions.$inferSelect;
}

export class RemoteCommandEnvelopesRepository {
  constructor(private readonly database: Database = dbWrite) {}

  async enqueue(input: {
    sessionId: string;
    organizationId: string;
    userId: string;
    commandId: string;
    sequence: number;
    expiresAt: Date;
    envelope: EncryptedRemoteCommand;
  }): Promise<EnqueueRemoteCommandResult> {
    return this.database.transaction(async (tx) => {
      const [authority] = await tx
        .select({ session: remoteSessions, host: remoteHosts })
        .from(remoteSessions)
        .innerJoin(
          remoteHosts,
          and(
            eq(remoteHosts.id, remoteSessions.host_id),
            eq(remoteHosts.organization_id, remoteSessions.organization_id),
            eq(remoteHosts.user_id, remoteSessions.user_id),
            isNull(remoteHosts.revoked_at),
          ),
        )
        .where(
          and(
            eq(remoteSessions.id, input.sessionId),
            eq(remoteSessions.organization_id, input.organizationId),
            eq(remoteSessions.user_id, input.userId),
            eq(remoteSessions.status, "active"),
          ),
        )
        .for("update", { of: remoteSessions });
      if (!authority) return { kind: "not_found" };
      if (
        authority.session.controller_key_id !== input.envelope.senderKeyId ||
        authority.host.runtime_key_id !== input.envelope.recipientKeyId
      ) {
        return { kind: "wrong_keys" };
      }
      if (input.sequence <= authority.session.last_sequence) {
        return { kind: "replay" };
      }
      const [command] = await tx
        .insert(remoteCommandEnvelopes)
        .values({
          session_id: input.sessionId,
          organization_id: input.organizationId,
          user_id: input.userId,
          command_id: input.commandId,
          sequence: input.sequence,
          envelope: input.envelope,
          expires_at: input.expiresAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!command) return { kind: "replay" };
      await tx
        .update(remoteSessions)
        .set({
          last_sequence: input.sequence,
          last_seen_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(remoteSessions.id, input.sessionId));
      return { kind: "queued", command };
    });
  }

  async claimNext(sessionId: string, hostId: string): Promise<ClaimedRemoteCommand | null> {
    return this.database.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.id, sessionId),
            eq(remoteSessions.host_id, hostId),
            eq(remoteSessions.status, "active"),
          ),
        )
        .limit(1);
      if (!session) return null;
      const now = new Date();
      await tx
        .update(remoteCommandEnvelopes)
        .set({ status: "expired", updated_at: now })
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, sessionId),
            inArray(remoteCommandEnvelopes.status, ["pending", "claimed"]),
            lt(remoteCommandEnvelopes.expires_at, now),
          ),
        );
      const [candidate] = await tx
        .select()
        .from(remoteCommandEnvelopes)
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, sessionId),
            gt(remoteCommandEnvelopes.expires_at, now),
            or(
              eq(remoteCommandEnvelopes.status, "pending"),
              and(
                eq(remoteCommandEnvelopes.status, "claimed"),
                lt(remoteCommandEnvelopes.claim_expires_at, now),
              ),
            ),
          ),
        )
        .orderBy(asc(remoteCommandEnvelopes.created_at))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return null;
      const [claimed] = await tx
        .update(remoteCommandEnvelopes)
        .set({
          status: "claimed",
          attempts: sql`${remoteCommandEnvelopes.attempts} + 1`,
          claim_expires_at: new Date(now.getTime() + CLAIM_LEASE_MS),
          updated_at: now,
        })
        .where(eq(remoteCommandEnvelopes.id, candidate.id))
        .returning();
      return claimed ? { command: claimed, session } : null;
    });
  }

  async complete(input: {
    sessionId: string;
    commandId: string;
    hostId: string;
    resultEnvelope: EncryptedRemoteCommand;
  }): Promise<RemoteCommandEnvelope | undefined> {
    return this.database.transaction(async (tx) => {
      const [authority] = await tx
        .select({
          id: remoteSessions.id,
          controllerKeyId: remoteSessions.controller_key_id,
          hostKeyId: remoteHosts.runtime_key_id,
        })
        .from(remoteSessions)
        .innerJoin(remoteHosts, eq(remoteHosts.id, remoteSessions.host_id))
        .where(
          and(
            eq(remoteSessions.id, input.sessionId),
            eq(remoteSessions.host_id, input.hostId),
            eq(remoteSessions.status, "active"),
          ),
        )
        .limit(1);
      if (
        !authority?.controllerKeyId ||
        input.resultEnvelope.recipientKeyId !== authority.controllerKeyId ||
        input.resultEnvelope.senderKeyId !== authority.hostKeyId
      ) {
        return undefined;
      }
      const now = new Date();
      const [completed] = await tx
        .update(remoteCommandEnvelopes)
        .set({
          status: "completed",
          result_envelope: input.resultEnvelope,
          claim_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, input.sessionId),
            eq(remoteCommandEnvelopes.command_id, input.commandId),
            eq(remoteCommandEnvelopes.status, "claimed"),
          ),
        )
        .returning();
      return completed;
    });
  }

  async readOwnedResult(
    sessionId: string,
    commandId: string,
    organizationId: string,
    userId: string,
  ): Promise<RemoteCommandEnvelope | undefined> {
    const [row] = await this.database
      .select({ command: remoteCommandEnvelopes })
      .from(remoteCommandEnvelopes)
      .innerJoin(
        remoteSessions,
        and(
          eq(remoteSessions.id, remoteCommandEnvelopes.session_id),
          eq(remoteSessions.organization_id, remoteCommandEnvelopes.organization_id),
          eq(remoteSessions.user_id, remoteCommandEnvelopes.user_id),
          eq(remoteSessions.status, "active"),
        ),
      )
      .where(
        and(
          eq(remoteCommandEnvelopes.session_id, sessionId),
          eq(remoteCommandEnvelopes.command_id, commandId),
          eq(remoteCommandEnvelopes.organization_id, organizationId),
          eq(remoteCommandEnvelopes.user_id, userId),
        ),
      )
      .limit(1);
    return row?.command;
  }
}

export const remoteCommandEnvelopesRepository = new RemoteCommandEnvelopesRepository();
