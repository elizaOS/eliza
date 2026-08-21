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

  async revoke(
    id: string,
    orgId: string,
    userId: string,
  ): Promise<RevokeRemoteSessionResult | undefined> {
    const now = new Date();
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
      if (
        current.status === "revoked" ||
        current.status === "denied" ||
        current.status === "expired"
      ) {
        return { session: current, alreadyEnded: true };
      }

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
