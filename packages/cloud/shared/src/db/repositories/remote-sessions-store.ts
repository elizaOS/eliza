/**
 * Persists remote-control sessions while keeping every authorization-sensitive
 * operation bound to the current primary-database owner of the target agent.
 * The injectable database keeps the same production queries testable against
 * an isolated real PostgreSQL-compatible engine.
 */

import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { Database } from "../client";
import { isRemotePairingSessionCurrent } from "../crypto/remote-pairing-code";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import {
  type NewRemoteSession,
  type RemoteSession,
  type RemoteSessionStatus,
  remoteSessions,
} from "../schemas/remote-sessions";

const ACTIVE_STATUSES: RemoteSessionStatus[] = ["pending", "active"];

export interface RevokeRemoteSessionResult {
  session: RemoteSession;
  alreadyEnded: boolean;
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

    return this.database.transaction(async (tx) => {
      const [ownedAgent] = await tx
        .select({ id: agentSandboxes.id })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, data.agent_id),
            eq(agentSandboxes.organization_id, data.organization_id),
            eq(agentSandboxes.user_id, data.user_id),
            isNull(agentSandboxes.deleted_at),
          ),
        )
        .for("update");
      if (!ownedAgent) return undefined;

      const now = new Date();
      // Run-out challenges reach their own terminal state before the
      // replacement denies whatever is still genuinely pending.
      await this.transitionExpired(tx, data.agent_id, data.organization_id, data.user_id, now);
      await tx
        .update(remoteSessions)
        .set({ status: "denied", updated_at: now, ended_at: now })
        .where(
          and(
            eq(remoteSessions.agent_id, data.agent_id),
            eq(remoteSessions.organization_id, data.organization_id),
            eq(remoteSessions.user_id, data.user_id),
            eq(remoteSessions.status, "pending"),
          ),
        );

      const [row] = await tx.insert(remoteSessions).values(data).returning();
      if (!row) throw new Error("Failed to create remote session");
      return row;
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
    return this.database.transaction(async (tx) => {
      const [authorized] = await tx
        .select({ agentId: remoteSessions.agent_id })
        .from(remoteSessions)
        .innerJoin(
          agentSandboxes,
          and(
            eq(agentSandboxes.id, remoteSessions.agent_id),
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
      if (!authorized) return undefined;

      const [current] = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.id, id),
            eq(remoteSessions.organization_id, orgId),
            eq(remoteSessions.user_id, userId),
            eq(remoteSessions.agent_id, authorized.agentId),
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
            eq(remoteSessions.agent_id, authorized.agentId),
            inArray(remoteSessions.status, ACTIVE_STATUSES),
          ),
        )
        .returning();
      if (!row) throw new Error("Locked remote session could not be revoked");
      return { session: row, alreadyEnded: false };
    });
  }
}
