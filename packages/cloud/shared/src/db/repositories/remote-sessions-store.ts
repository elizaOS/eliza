/**
 * Persists remote-control sessions while keeping every authorization-sensitive
 * operation bound to the current primary-database owner of the target agent.
 * The injectable database keeps the same production queries testable against
 * an isolated real PostgreSQL-compatible engine.
 */

import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "../client";
import {
  isRemotePairingSessionCurrent,
  verifyRemotePairingCodeVerifier,
} from "../crypto/remote-pairing-code";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { remoteHosts } from "../schemas/remote-hosts";
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

export interface ConsumeRemotePairingInput {
  organizationId: string;
  userId: string;
  code: string;
  pairingSecret: string;
  controller: {
    deviceId: string;
    keyId: string;
    displayName: string;
    platform: string;
    signingPublicKeyJwk: JsonWebKey;
    encryptionPublicKeyJwk: JsonWebKey;
  };
}

export type ConsumeRemotePairingResult =
  | { kind: "consumed"; session: RemoteSession }
  | { kind: "invalid" }
  | { kind: "ambiguous" };

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
      data.host_id ||
      !data.pairing_token_hash
    ) {
      throw new TypeError("Pending remote session input violates its ownership contract");
    }
    const agentId = data.agent_id;

    return this.database.transaction(async (tx) => {
      const [ownedAgent] = await tx
        .select({ id: agentSandboxes.id })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, data.organization_id),
            eq(agentSandboxes.user_id, data.user_id),
            isNull(agentSandboxes.deleted_at),
          ),
        )
        .for("update");
      if (!ownedAgent) return undefined;

      const now = new Date();
      await tx
        .update(remoteSessions)
        .set({ status: "denied", updated_at: now, ended_at: now })
        .where(
          and(
            eq(remoteSessions.agent_id, agentId),
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

  /** Creates a pending challenge for a Cloud-account-owned workstation/VPS. */
  async createPendingForOwnedHost(data: NewRemoteSession): Promise<RemoteSession | undefined> {
    if (
      data.status !== "pending" ||
      data.requester_identity !== data.user_id ||
      !data.id ||
      !data.organization_id ||
      !data.user_id ||
      !data.host_id ||
      data.agent_id ||
      !data.pairing_token_hash
    ) {
      throw new TypeError("Pending remote host session input violates its ownership contract");
    }
    const hostId = data.host_id;

    return this.database.transaction(async (tx) => {
      const [ownedHost] = await tx
        .select({ id: remoteHosts.id })
        .from(remoteHosts)
        .where(
          and(
            eq(remoteHosts.id, hostId),
            eq(remoteHosts.organization_id, data.organization_id),
            eq(remoteHosts.user_id, data.user_id),
            isNull(remoteHosts.revoked_at),
          ),
        )
        .for("update");
      if (!ownedHost) return undefined;

      const now = new Date();
      await tx
        .update(remoteSessions)
        .set({ status: "denied", updated_at: now, ended_at: now })
        .where(
          and(
            eq(remoteSessions.host_id, hostId),
            eq(remoteSessions.organization_id, data.organization_id),
            eq(remoteSessions.user_id, data.user_id),
            eq(remoteSessions.status, "pending"),
          ),
        );

      const [row] = await tx.insert(remoteSessions).values(data).returning();
      if (!row) throw new Error("Failed to create remote host session");
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

      const rows = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.agent_id, agentId),
            eq(remoteSessions.organization_id, orgId),
            eq(remoteSessions.user_id, userId),
            inArray(remoteSessions.status, ACTIVE_STATUSES),
          ),
        )
        .orderBy(desc(remoteSessions.created_at));
      const nowMs = Date.now();
      return rows.filter((row) =>
        isRemotePairingSessionCurrent(row.status, row.pairing_token_hash, nowMs),
      );
    });
  }

  async listActiveByOwnedHost(
    hostId: string,
    orgId: string,
    userId: string,
  ): Promise<RemoteSession[] | undefined> {
    return this.database.transaction(async (tx) => {
      const [ownedHost] = await tx
        .select({ id: remoteHosts.id })
        .from(remoteHosts)
        .where(
          and(
            eq(remoteHosts.id, hostId),
            eq(remoteHosts.organization_id, orgId),
            eq(remoteHosts.user_id, userId),
            isNull(remoteHosts.revoked_at),
          ),
        )
        .for("share");
      if (!ownedHost) return undefined;

      const rows = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.host_id, hostId),
            eq(remoteSessions.organization_id, orgId),
            eq(remoteSessions.user_id, userId),
            inArray(remoteSessions.status, ACTIVE_STATUSES),
          ),
        )
        .orderBy(desc(remoteSessions.created_at));
      const nowMs = Date.now();
      return rows.filter((row) =>
        isRemotePairingSessionCurrent(row.status, row.pairing_token_hash, nowMs),
      );
    });
  }

  /** Atomically consumes one owner-bound code and installs controller keys. */
  async consumePendingForOwner(
    input: ConsumeRemotePairingInput,
  ): Promise<ConsumeRemotePairingResult> {
    return this.database.transaction(async (tx) => {
      const candidates = await tx
        .select({ session: remoteSessions })
        .from(remoteSessions)
        .leftJoin(
          agentSandboxes,
          and(
            eq(agentSandboxes.id, remoteSessions.agent_id),
            eq(agentSandboxes.organization_id, remoteSessions.organization_id),
            eq(agentSandboxes.user_id, remoteSessions.user_id),
            isNull(agentSandboxes.deleted_at),
          ),
        )
        .leftJoin(
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
            eq(remoteSessions.organization_id, input.organizationId),
            eq(remoteSessions.user_id, input.userId),
            eq(remoteSessions.status, "pending"),
            or(
              eq(agentSandboxes.id, remoteSessions.agent_id),
              eq(remoteHosts.id, remoteSessions.host_id),
            ),
          ),
        )
        .for("update", { of: remoteSessions });

      const now = new Date();
      const matches: RemoteSession[] = [];
      for (const { session } of candidates) {
        if (!session.pairing_token_hash) continue;
        const valid = await verifyRemotePairingCodeVerifier(
          input.pairingSecret,
          {
            organizationId: session.organization_id,
            userId: session.user_id,
            agentId: session.agent_id ?? session.host_id!,
            sessionId: session.id,
          },
          input.code,
          session.pairing_token_hash,
          now,
        );
        if (valid) matches.push(session);
      }
      if (matches.length === 0) return { kind: "invalid" };
      if (matches.length > 1) return { kind: "ambiguous" };
      const match = matches[0]!;
      const [session] = await tx
        .update(remoteSessions)
        .set({
          status: "active",
          pairing_token_hash: null,
          controller_device_id: input.controller.deviceId,
          controller_key_id: input.controller.keyId,
          controller_display_name: input.controller.displayName,
          controller_platform: input.controller.platform,
          controller_signing_public_jwk: input.controller.signingPublicKeyJwk,
          controller_encryption_public_jwk: input.controller.encryptionPublicKeyJwk,
          last_sequence: 0,
          last_seen_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(remoteSessions.id, match.id),
            eq(remoteSessions.status, "pending"),
            eq(remoteSessions.pairing_token_hash, match.pairing_token_hash!),
          ),
        )
        .returning();
      if (!session) return { kind: "invalid" };
      return { kind: "consumed", session };
    });
  }

  async revoke(
    id: string,
    orgId: string,
    userId: string,
  ): Promise<RevokeRemoteSessionResult | undefined> {
    const now = new Date();
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.id, id),
            eq(remoteSessions.organization_id, orgId),
            eq(remoteSessions.user_id, userId),
          ),
        )
        .for("update");
      if (!current) return undefined;
      const targetOwned = current.agent_id
        ? Boolean(
            (
              await tx
                .select({ id: agentSandboxes.id })
                .from(agentSandboxes)
                .where(
                  and(
                    eq(agentSandboxes.id, current.agent_id),
                    eq(agentSandboxes.organization_id, orgId),
                    eq(agentSandboxes.user_id, userId),
                    isNull(agentSandboxes.deleted_at),
                  ),
                )
                .limit(1)
            )[0],
          )
        : Boolean(
            current.host_id &&
              (
                await tx
                  .select({ id: remoteHosts.id })
                  .from(remoteHosts)
                  .where(
                    and(
                      eq(remoteHosts.id, current.host_id),
                      eq(remoteHosts.organization_id, orgId),
                      eq(remoteHosts.user_id, userId),
                      isNull(remoteHosts.revoked_at),
                    ),
                  )
                  .limit(1)
              )[0],
          );
      if (!targetOwned) return undefined;
      if (current.status === "revoked" || current.status === "denied") {
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
            inArray(remoteSessions.status, ACTIVE_STATUSES),
          ),
        )
        .returning();
      if (!row) throw new Error("Locked remote session could not be revoked");
      return { session: row, alreadyEnded: false };
    });
  }
}
