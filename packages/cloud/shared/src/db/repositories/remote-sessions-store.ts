/**
 * Persists remote-control sessions while keeping every authorization-sensitive
 * operation bound to the current primary-database owner of the target agent.
 * The injectable database keeps the same production queries testable against
 * an isolated real PostgreSQL-compatible engine.
 */

import { ElizaError } from "@elizaos/core";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { hashRemoteHostToken } from "../crypto/remote-host-token";
import {
  isRemotePairingSessionCurrent,
  verifyRemotePairingCodeVerifier,
} from "../crypto/remote-pairing-code";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { remoteCommandEnvelopes } from "../schemas/remote-command-envelopes";
import { remoteHosts } from "../schemas/remote-hosts";
import {
  type NewRemoteSession,
  type RemoteSession,
  type RemoteSessionStatus,
  remoteSessions,
} from "../schemas/remote-sessions";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const ACTIVE_STATUSES: RemoteSessionStatus[] = ["pending", "active"];

export interface RevokeRemoteSessionResult {
  session: RemoteSession;
  alreadyEnded: boolean;
  cleanup?: { commands: number; more: boolean };
}

export type ActivateRemoteHostSessionResult =
  | { kind: "activated"; session: RemoteSession }
  | { kind: "not_found" }
  | { kind: "invalid_pairing" };

const SESSION_COMMAND_CLEANUP_BATCH = 500;

function storageFailure(message: string, context: Record<string, unknown>): ElizaError {
  return new ElizaError(message, {
    code: "REMOTE_RELAY_STORAGE_FAILURE",
    severity: "fatal",
    context,
  });
}

export class RemoteSessionsRepository {
  constructor(private readonly database: Database) {}

  /**
   * Creates the sole pending challenge for an agent under a row lock. The lock
   * serializes ownership changes and concurrent issuers; a newer challenge
   * denies every older pending challenge before it becomes visible.
   */
  async createPendingForOwnedAgent(data: NewRemoteSession): Promise<RemoteSession | undefined> {
    if (
      data.status !== "pending" ||
      data.requester_identity !== data.user_id ||
      !data.id ||
      !data.organization_id ||
      !data.user_id ||
      !data.agent_id ||
      !data.pairing_token_hash ||
      !(data.expires_at instanceof Date) ||
      Number.isNaN(data.expires_at.getTime())
    ) {
      throw new TypeError("Pending remote session input violates its ownership contract");
    }
    const agentId = data.agent_id;
    const organizationId = data.organization_id;
    const userId = data.user_id;

    return this.database.transaction(async (tx) => {
      const [ownedAgent] = await tx
        .select({ id: agentSandboxes.id })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, organizationId),
            eq(agentSandboxes.user_id, userId),
            isNull(agentSandboxes.deleted_at),
          ),
        )
        .for("update");
      if (!ownedAgent) return undefined;

      const now = new Date();
      // Run-out challenges reach their own terminal state before the
      // replacement denies whatever is still genuinely pending.
      await this.transitionExpired(tx, agentId, organizationId, userId, now);
      await tx
        .update(remoteSessions)
        .set({ status: "denied", updated_at: now, ended_at: now })
        .where(
          and(
            eq(remoteSessions.agent_id, agentId),
            eq(remoteSessions.organization_id, organizationId),
            eq(remoteSessions.user_id, userId),
            eq(remoteSessions.status, "pending"),
          ),
        );

      const [row] = await tx.insert(remoteSessions).values(data).returning();
      if (!row) throw new Error("Failed to create remote session");
      return row;
    });
  }

  /** Creates one pending, expiring host pairing grant under the host lock. */
  async createPendingForOwnedHost(data: NewRemoteSession): Promise<RemoteSession | undefined> {
    if (
      data.status !== "pending" ||
      data.requester_identity !== data.user_id ||
      !data.id ||
      !data.grant_id ||
      !data.grant_revision ||
      !data.organization_id ||
      !data.user_id ||
      !data.host_id ||
      data.agent_id ||
      !data.controller_device_id ||
      !data.controller_key_id ||
      !data.controller_signing_public_jwk ||
      !data.controller_encryption_public_jwk ||
      !data.pairing_token_hash ||
      !(data.expires_at instanceof Date) ||
      !(data.grant_expires_at instanceof Date) ||
      data.grant_expires_at.getTime() <= data.expires_at.getTime()
    ) {
      throw new ElizaError("Pending remote host session input violates its authority contract", {
        code: "REMOTE_SESSION_INVALID_INPUT",
        severity: "fatal",
      });
    }
    const hostId = data.host_id;
    const organizationId = data.organization_id;
    const userId = data.user_id;
    const controllerDeviceId = data.controller_device_id;

    return this.database.transaction(async (tx) => {
      const [host] = await tx
        .select({ id: remoteHosts.id, runtimeKeyId: remoteHosts.runtime_key_id })
        .from(remoteHosts)
        .where(
          and(
            eq(remoteHosts.id, hostId),
            eq(remoteHosts.organization_id, organizationId),
            eq(remoteHosts.user_id, userId),
            eq(remoteHosts.status, "active"),
          ),
        )
        .for("update");
      if (!host) return undefined;
      if (data.target_key_id && host.runtimeKeyId !== data.target_key_id) return undefined;

      const now = await readPostLockDatabaseNow(tx);
      await tx
        .update(remoteSessions)
        .set({ status: "expired", pairing_token_hash: null, ended_at: now, updated_at: now })
        .where(
          and(
            eq(remoteSessions.host_id, host.id),
            eq(remoteSessions.organization_id, organizationId),
            eq(remoteSessions.user_id, userId),
            eq(remoteSessions.controller_device_id, controllerDeviceId),
            eq(remoteSessions.status, "pending"),
            lte(remoteSessions.expires_at, now),
          ),
        );
      await tx
        .update(remoteSessions)
        .set({ status: "denied", pairing_token_hash: null, ended_at: now, updated_at: now })
        .where(
          and(
            eq(remoteSessions.host_id, host.id),
            eq(remoteSessions.organization_id, organizationId),
            eq(remoteSessions.user_id, userId),
            eq(remoteSessions.controller_device_id, controllerDeviceId),
            eq(remoteSessions.status, "pending"),
          ),
        );

      const [session] = await tx
        .insert(remoteSessions)
        .values({ ...data, target_key_id: host.runtimeKeyId })
        .returning();
      if (!session) {
        throw storageFailure("Failed to create remote host session", { hostId: host.id });
      }
      return session;
    });
  }

  /**
   * Consumes a host-bound pairing code exactly once. Host authentication,
   * expiry, verifier validation, and activation occur while host then session
   * rows are locked, so neither revocation nor a second consumer can race it.
   */
  async activatePendingHost(input: {
    sessionId: string;
    hostId: string;
    hostToken: string;
    code: string;
    pairingSecret: string;
  }): Promise<ActivateRemoteHostSessionResult> {
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
      if (!session || session.status !== "pending" || !session.pairing_token_hash) {
        return { kind: "invalid_pairing" };
      }
      const now = await readPostLockDatabaseNow(tx);
      if (
        !session.expires_at ||
        session.expires_at.getTime() <= now.getTime() ||
        !session.grant_expires_at ||
        session.grant_expires_at.getTime() <= now.getTime()
      ) {
        await tx
          .update(remoteSessions)
          .set({ status: "expired", pairing_token_hash: null, ended_at: now, updated_at: now })
          .where(eq(remoteSessions.id, session.id));
        return { kind: "invalid_pairing" };
      }
      const valid = await verifyRemotePairingCodeVerifier(
        input.pairingSecret,
        {
          organizationId: host.organization_id,
          userId: host.user_id,
          hostId: host.id,
          sessionId: session.id,
        },
        input.code,
        session.pairing_token_hash,
        now,
      );
      if (!valid) return { kind: "invalid_pairing" };

      const [activated] = await tx
        .update(remoteSessions)
        .set({
          status: "active",
          pairing_token_hash: null,
          pairing_consumed_at: now,
          updated_at: now,
        })
        .where(and(eq(remoteSessions.id, session.id), eq(remoteSessions.status, "pending")))
        .returning();
      if (!activated) {
        throw storageFailure("Locked remote host session could not be activated", {
          sessionId: session.id,
        });
      }
      return { kind: "activated", session: activated };
    });
  }

  async listByOwnedHost(
    hostId: string,
    organizationId: string,
    userId: string,
  ): Promise<RemoteSession[] | undefined> {
    return this.database.transaction(async (tx) => {
      const [host] = await tx
        .select({ id: remoteHosts.id })
        .from(remoteHosts)
        .where(
          and(
            eq(remoteHosts.id, hostId),
            eq(remoteHosts.organization_id, organizationId),
            eq(remoteHosts.user_id, userId),
          ),
        )
        .for("share");
      if (!host) return undefined;
      return tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.host_id, host.id),
            eq(remoteSessions.organization_id, organizationId),
            eq(remoteSessions.user_id, userId),
            inArray(remoteSessions.status, ["pending", "active"]),
          ),
        )
        .orderBy(desc(remoteSessions.created_at));
    });
  }

  async listActiveByOwnedAgent(
    agentId: string,
    orgId: string,
    userId: string,
  ): Promise<RemoteSession[] | undefined> {
    return this.database.transaction(async (tx) => {
      const [ownedAgent] = await tx
        .select({ id: agentSandboxes.id })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.user_id, userId),
            isNull(agentSandboxes.deleted_at),
          ),
        )
        .for("share");
      if (!ownedAgent) return undefined;

      const now = new Date();
      await this.transitionExpired(tx, agentId, orgId, userId, now);

      const rows = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.agent_id, agentId),
            eq(remoteSessions.organization_id, orgId),
            eq(remoteSessions.user_id, userId),
            or(
              eq(remoteSessions.status, "active"),
              and(
                eq(remoteSessions.status, "pending"),
                or(gt(remoteSessions.expires_at, now), isNull(remoteSessions.expires_at)),
              ),
            ),
          ),
        )
        .orderBy(desc(remoteSessions.created_at));
      // Legacy pending rows without a first-class expiry fall back to the
      // signed expiry embedded in their verifier.
      const nowMs = now.getTime();
      return rows.filter(
        (row) =>
          row.expires_at !== null ||
          isRemotePairingSessionCurrent(row.status, row.pairing_token_hash, nowMs),
      );
    });
  }

  /**
   * Transitions run-out pending challenges to their terminal `expired` state.
   * Only rows with a first-class expiry can transition in SQL; legacy rows
   * keep relying on the verifier's signed expiry at read time.
   */
  private async transitionExpired(
    tx: Pick<Database, "update">,
    agentId: string,
    orgId: string,
    userId: string,
    now: Date,
  ): Promise<void> {
    await tx
      .update(remoteSessions)
      .set({ status: "expired", updated_at: now, ended_at: now })
      .where(
        and(
          eq(remoteSessions.agent_id, agentId),
          eq(remoteSessions.organization_id, orgId),
          eq(remoteSessions.user_id, userId),
          eq(remoteSessions.status, "pending"),
          lte(remoteSessions.expires_at, now),
        ),
      );
  }

  /**
   * Terminalizes one already-locked pending row whose grant has run out.
   * A run-out pairing challenge must never be reported as freshly revoked, so
   * this runs inside the caller's lock before any terminal decision. Rows
   * predating the first-class column carry NULL and are judged by the signed
   * expiry inside their verifier, matching what listing already hides.
   */
  private async reconcileLockedRowExpiry(
    tx: Pick<Database, "update">,
    row: RemoteSession,
    now: Date,
  ): Promise<RemoteSession | undefined> {
    if (row.status !== "pending") return undefined;
    const runOut =
      row.expires_at !== null
        ? row.expires_at.getTime() <= now.getTime()
        : !isRemotePairingSessionCurrent(row.status, row.pairing_token_hash, now.getTime());
    if (!runOut) return undefined;

    const [expired] = await tx
      .update(remoteSessions)
      .set({ status: "expired", updated_at: now, ended_at: now })
      .where(and(eq(remoteSessions.id, row.id), eq(remoteSessions.status, "pending")))
      .returning();
    return expired;
  }

  /**
   * Terminalizes run-out pending grants without requiring current ownership.
   *
   * Every request-path predicate is scoped to the agent's present owner, so an
   * ownership transfer strands the previous owner's pending row as `pending`
   * forever. This sweep is the cleanup owner for those rows: it matches on
   * elapsed first-class expiry alone. Each call is bounded so a backlog is
   * drained over several passes rather than locking an unbounded row set, and
   * it returns how many rows it terminalized so a caller can loop until zero.
   */
  async expireRunOutPendingSessions(limit = 500, now: Date = new Date()): Promise<number> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TypeError("Remote session expiry sweep limit must be a positive integer");
    }
    return this.database.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: remoteSessions.id })
        .from(remoteSessions)
        .where(and(eq(remoteSessions.status, "pending"), lte(remoteSessions.expires_at, now)))
        .orderBy(remoteSessions.expires_at)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (candidates.length === 0) return 0;

      const rows = await tx
        .update(remoteSessions)
        .set({ status: "expired", updated_at: now, ended_at: now })
        .where(
          and(
            inArray(
              remoteSessions.id,
              candidates.map((candidate) => candidate.id),
            ),
            eq(remoteSessions.status, "pending"),
          ),
        )
        .returning({ id: remoteSessions.id });
      return rows.length;
    });
  }

  async revoke(
    id: string,
    orgId: string,
    userId: string,
  ): Promise<RevokeRemoteSessionResult | undefined> {
    const [target] = await this.database
      .select({ hostId: remoteSessions.host_id })
      .from(remoteSessions)
      .where(
        and(
          eq(remoteSessions.id, id),
          eq(remoteSessions.organization_id, orgId),
          eq(remoteSessions.user_id, userId),
        ),
      )
      .limit(1);
    if (target?.hostId) return this.revokeOwnedHostSession(id, target.hostId, orgId, userId);
    return this.database.transaction(async (tx) => {
      const [authorized] = await tx
        .select({ agentId: remoteSessions.agent_id })
        .from(remoteSessions)
        .innerJoin(
          agentSandboxes,
          and(
            sql`${agentSandboxes.id} = ${remoteSessions.agent_id}`,
            eq(agentSandboxes.organization_id, remoteSessions.organization_id),
            eq(agentSandboxes.user_id, remoteSessions.user_id),
            isNull(agentSandboxes.deleted_at),
          ),
        )
        .where(
          and(
            eq(remoteSessions.id, id),
            eq(remoteSessions.organization_id, orgId),
            eq(remoteSessions.user_id, userId),
          ),
        )
        .for("update", { of: agentSandboxes });
      if (!authorized?.agentId) return undefined;
      const authorizedAgentId = authorized.agentId;

      const [current] = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.id, id),
            eq(remoteSessions.organization_id, orgId),
            eq(remoteSessions.user_id, userId),
            eq(remoteSessions.agent_id, authorizedAgentId),
          ),
        )
        .for("update");
      if (!current) return undefined;
      // Sampled only once both locks are held: a clock read taken before
      // waiting on contention would judge expiry against a stale instant.
      const now = new Date();
      if (
        current.status === "revoked" ||
        current.status === "denied" ||
        current.status === "expired"
      ) {
        return { session: current, alreadyEnded: true };
      }

      // A pending grant that ran out is already terminal; only an `active`
      // session survives pairing-challenge expiry and is genuinely revocable.
      const expired = await this.reconcileLockedRowExpiry(tx, current, now);
      if (expired) return { session: expired, alreadyEnded: true };

      const [row] = await tx
        .update(remoteSessions)
        .set({ status: "revoked", updated_at: now, ended_at: now })
        .where(
          and(
            eq(remoteSessions.id, id),
            eq(remoteSessions.organization_id, orgId),
            eq(remoteSessions.user_id, userId),
            eq(remoteSessions.agent_id, authorizedAgentId),
            inArray(remoteSessions.status, ACTIVE_STATUSES),
          ),
        )
        .returning();
      if (!row) throw new Error("Locked remote session could not be revoked");
      return { session: row, alreadyEnded: false };
    });
  }

  private async revokeOwnedHostSession(
    id: string,
    hostId: string,
    orgId: string,
    userId: string,
  ): Promise<RevokeRemoteSessionResult | undefined> {
    return this.database.transaction(async (tx) => {
      const [host] = await tx
        .select({ id: remoteHosts.id })
        .from(remoteHosts)
        .where(
          and(
            eq(remoteHosts.id, hostId),
            eq(remoteHosts.organization_id, orgId),
            eq(remoteHosts.user_id, userId),
          ),
        )
        .for("update");
      if (!host) return undefined;
      const [current] = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.id, id),
            eq(remoteSessions.host_id, host.id),
            eq(remoteSessions.organization_id, orgId),
            eq(remoteSessions.user_id, userId),
          ),
        )
        .for("update");
      if (!current) return undefined;

      const now = await readPostLockDatabaseNow(tx);
      let alreadyEnded = !ACTIVE_STATUSES.includes(current.status);
      let session = current;
      if (ACTIVE_STATUSES.includes(current.status)) {
        const terminalStatus =
          current.status === "pending" &&
          (!current.expires_at || current.expires_at.getTime() <= now.getTime())
            ? "expired"
            : "revoked";
        if (terminalStatus === "expired") alreadyEnded = true;
        const [ended] = await tx
          .update(remoteSessions)
          .set({
            status: terminalStatus,
            pairing_token_hash: null,
            ended_at: now,
            updated_at: now,
          })
          .where(
            and(eq(remoteSessions.id, current.id), inArray(remoteSessions.status, ACTIVE_STATUSES)),
          )
          .returning();
        if (!ended) {
          throw storageFailure("Locked remote host session could not be revoked", {
            sessionId: current.id,
          });
        }
        session = ended;
      }

      const commands = await tx
        .select({ id: remoteCommandEnvelopes.id, status: remoteCommandEnvelopes.status })
        .from(remoteCommandEnvelopes)
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, id),
            inArray(remoteCommandEnvelopes.status, ["pending", "claimed", "started"]),
          ),
        )
        .orderBy(asc(remoteCommandEnvelopes.id))
        .limit(SESSION_COMMAND_CLEANUP_BATCH)
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
            status: "cancelled",
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
      const [remaining] = await tx
        .select({ id: remoteCommandEnvelopes.id })
        .from(remoteCommandEnvelopes)
        .where(
          and(
            eq(remoteCommandEnvelopes.session_id, id),
            inArray(remoteCommandEnvelopes.status, ["pending", "claimed", "started"]),
          ),
        )
        .limit(1);
      return {
        session,
        alreadyEnded,
        cleanup: { commands: commands.length, more: Boolean(remaining) },
      };
    });
  }
}
