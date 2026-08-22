/**
 * Owns tenant-scoped remote host enrollment, credential authentication, and
 * bounded revocation cleanup. Every mutating path locks the host before its
 * sessions and commands so relay operations cannot outlive revocation.
 */

import { ElizaError } from "@elizaos/core";
import { canonicalizeRemoteControlValue } from "@elizaos/shared/contracts/remote-control";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { Database } from "../client";
import { hashRemoteHostToken } from "../crypto/remote-host-token";
import { dbWrite } from "../helpers";
import { remoteCommandEnvelopes } from "../schemas/remote-command-envelopes";
import { type NewRemoteHost, type RemoteHost, remoteHosts } from "../schemas/remote-hosts";
import { remoteSessions } from "../schemas/remote-sessions";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const HOST_REVOCATION_SESSION_BATCH = 100;
const HOST_REVOCATION_COMMAND_BATCH = 500;

export type CreateRemoteHostResult = { kind: "created"; host: RemoteHost } | { kind: "conflict" };

export interface RecoverRemoteHostCredentialInput {
  hostId: string;
  organizationId: string;
  userId: string;
  deviceId: string;
  displayName: string;
  platform: string;
  connectionMode: string;
  runtimeKeyId: string;
  signingPublicJwk: JsonWebKey;
  encryptionPublicJwk: JsonWebKey;
  hostTokenHash: string;
}

export type RecoverRemoteHostCredentialResult =
  | { kind: "recovered"; host: RemoteHost }
  | { kind: "not_found" }
  | { kind: "mismatch" }
  | { kind: "revoked" };

export interface RevokeRemoteHostResult {
  host: RemoteHost;
  alreadyRevoked: boolean;
  cleanup: { sessions: number; commands: number; more: boolean };
}

function storageFailure(message: string, context: Record<string, unknown>): ElizaError {
  return new ElizaError(message, {
    code: "REMOTE_RELAY_STORAGE_FAILURE",
    severity: "fatal",
    context,
  });
}

export class RemoteHostsRepository {
  constructor(private readonly database: Database = dbWrite) {}

  async createOwned(input: NewRemoteHost): Promise<CreateRemoteHostResult> {
    if (
      !input.id ||
      !input.organization_id ||
      !input.user_id ||
      !input.device_id ||
      !input.runtime_key_id ||
      !input.host_token_hash ||
      input.status === "revoked"
    ) {
      throw new ElizaError("Remote host enrollment input is incomplete", {
        code: "REMOTE_HOST_INVALID_INPUT",
        severity: "fatal",
      });
    }
    const [host] = await this.database
      .insert(remoteHosts)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return host ? { kind: "created", host } : { kind: "conflict" };
  }

  async listOwned(organizationId: string, userId: string): Promise<RemoteHost[]> {
    return this.database
      .select()
      .from(remoteHosts)
      .where(and(eq(remoteHosts.organization_id, organizationId), eq(remoteHosts.user_id, userId)))
      .orderBy(desc(remoteHosts.created_at));
  }

  async getOwned(
    hostId: string,
    organizationId: string,
    userId: string,
  ): Promise<RemoteHost | undefined> {
    const [host] = await this.database
      .select()
      .from(remoteHosts)
      .where(
        and(
          eq(remoteHosts.id, hostId),
          eq(remoteHosts.organization_id, organizationId),
          eq(remoteHosts.user_id, userId),
        ),
      )
      .limit(1);
    return host;
  }

  async authenticate(hostId: string, token: string): Promise<RemoteHost | undefined> {
    let tokenHash: string;
    try {
      tokenHash = await hashRemoteHostToken(token);
    } catch {
      // error-policy:J3 malformed bearer material is an explicit auth miss.
      return undefined;
    }
    const [host] = await this.database
      .select()
      .from(remoteHosts)
      .where(
        and(
          eq(remoteHosts.id, hostId),
          eq(remoteHosts.host_token_hash, tokenHash),
          eq(remoteHosts.status, "active"),
        ),
      )
      .limit(1);
    return host;
  }

  async recordManagedEnrollment(input: {
    hostId: string;
    organizationId: string;
    userId: string;
    hostname: string;
    preAuthKeyId: string;
  }): Promise<RemoteHost> {
    const [host] = await this.database
      .update(remoteHosts)
      .set({
        headscale_hostname: input.hostname,
        headscale_preauth_key_id: input.preAuthKeyId,
        headscale_cleanup_pending: true,
        headscale_cleanup_error: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(remoteHosts.id, input.hostId),
          eq(remoteHosts.organization_id, input.organizationId),
          eq(remoteHosts.user_id, input.userId),
          eq(remoteHosts.status, "active"),
        ),
      )
      .returning();
    if (!host) {
      throw storageFailure("Managed remote-host enrollment could not be recorded", {
        hostId: input.hostId,
      });
    }
    return host;
  }

  async recordManagedCleanupFailure(input: {
    hostId: string;
    organizationId: string;
    userId: string;
    message: string;
  }): Promise<void> {
    const [host] = await this.database
      .update(remoteHosts)
      .set({
        headscale_cleanup_pending: true,
        headscale_cleanup_error: input.message.slice(0, 1_000),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(remoteHosts.id, input.hostId),
          eq(remoteHosts.organization_id, input.organizationId),
          eq(remoteHosts.user_id, input.userId),
        ),
      )
      .returning({ id: remoteHosts.id });
    if (!host) {
      throw storageFailure("Managed remote-host cleanup failure could not be recorded", {
        hostId: input.hostId,
      });
    }
  }

  async completeManagedCleanup(input: {
    hostId: string;
    organizationId: string;
    userId: string;
  }): Promise<void> {
    const [host] = await this.database
      .update(remoteHosts)
      .set({
        headscale_preauth_key_id: null,
        headscale_hostname: null,
        headscale_cleanup_pending: false,
        headscale_cleanup_error: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(remoteHosts.id, input.hostId),
          eq(remoteHosts.organization_id, input.organizationId),
          eq(remoteHosts.user_id, input.userId),
        ),
      )
      .returning({ id: remoteHosts.id });
    if (!host) {
      throw storageFailure("Managed remote-host cleanup could not be completed", {
        hostId: input.hostId,
      });
    }
  }

  /**
   * Rotates a lost one-time host bearer only when the authenticated owner
   * proves the complete immutable public enrollment identity. This closes the
   * create-response -> secure-store crash window without making bearer hashes
   * reversible or reviving a revoked host.
   */
  async recoverCredential(
    input: RecoverRemoteHostCredentialInput,
  ): Promise<RecoverRemoteHostCredentialResult> {
    if (
      !input.hostId ||
      !input.organizationId ||
      !input.userId ||
      !input.deviceId ||
      !input.runtimeKeyId ||
      !input.hostTokenHash
    ) {
      throw new ElizaError("Remote host credential recovery input is incomplete", {
        code: "REMOTE_HOST_INVALID_INPUT",
        severity: "fatal",
      });
    }
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(remoteHosts)
        .where(
          and(
            eq(remoteHosts.id, input.hostId),
            eq(remoteHosts.organization_id, input.organizationId),
            eq(remoteHosts.user_id, input.userId),
          ),
        )
        .for("update");
      if (!current) return { kind: "not_found" };
      if (current.status !== "active") return { kind: "revoked" };
      if (
        current.device_id !== input.deviceId ||
        current.display_name !== input.displayName ||
        current.platform !== input.platform ||
        current.connection_mode !== input.connectionMode ||
        current.runtime_key_id !== input.runtimeKeyId ||
        canonicalizeRemoteControlValue(current.signing_public_jwk) !==
          canonicalizeRemoteControlValue(input.signingPublicJwk) ||
        canonicalizeRemoteControlValue(current.encryption_public_jwk) !==
          canonicalizeRemoteControlValue(input.encryptionPublicJwk)
      ) {
        return { kind: "mismatch" };
      }
      const now = await readPostLockDatabaseNow(tx);
      const [host] = await tx
        .update(remoteHosts)
        .set({ host_token_hash: input.hostTokenHash, updated_at: now })
        .where(and(eq(remoteHosts.id, current.id), eq(remoteHosts.status, "active")))
        .returning();
      if (!host) {
        throw storageFailure("Locked remote host credential could not be recovered", {
          hostId: current.id,
        });
      }
      return { kind: "recovered", host };
    });
  }

  /**
   * Revokes one host and terminalizes a bounded page of dependent state. A
   * repeated call continues cleanup even after the host is already revoked.
   */
  async revoke(
    hostId: string,
    organizationId: string,
    userId: string,
  ): Promise<RevokeRemoteHostResult | undefined> {
    return this.revokeMatching(
      hostId,
      and(eq(remoteHosts.organization_id, organizationId), eq(remoteHosts.user_id, userId)),
    );
  }

  /**
   * Lets an enrolled native host revoke only itself with its one-time bearer.
   * The token hash remains usable for bounded cleanup continuation after the
   * first page changes the host status to revoked.
   */
  async revokeAuthenticated(
    hostId: string,
    token: string,
  ): Promise<RevokeRemoteHostResult | undefined> {
    let tokenHash: string;
    try {
      tokenHash = await hashRemoteHostToken(token);
    } catch {
      // error-policy:J3 malformed bearer material is an explicit auth miss.
      return undefined;
    }
    return this.revokeMatching(hostId, eq(remoteHosts.host_token_hash, tokenHash));
  }

  private async revokeMatching(
    hostId: string,
    ownership: SQL<unknown> | undefined,
  ): Promise<RevokeRemoteHostResult | undefined> {
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(remoteHosts)
        .where(and(eq(remoteHosts.id, hostId), ownership))
        .for("update");
      if (!current) return undefined;

      const organizationId = current.organization_id;
      const userId = current.user_id;

      const now = await readPostLockDatabaseNow(tx);
      const alreadyRevoked = current.status === "revoked";
      let host = current;
      if (!alreadyRevoked) {
        const [revoked] = await tx
          .update(remoteHosts)
          .set({ status: "revoked", revoked_at: now, updated_at: now })
          .where(and(eq(remoteHosts.id, hostId), eq(remoteHosts.status, "active")))
          .returning();
        if (!revoked) {
          throw storageFailure("Locked remote host could not be revoked", { hostId });
        }
        host = revoked;
      }

      const sessions = await tx
        .select({ id: remoteSessions.id })
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.host_id, hostId),
            eq(remoteSessions.organization_id, organizationId),
            eq(remoteSessions.user_id, userId),
            inArray(remoteSessions.status, ["pending", "active"]),
          ),
        )
        .orderBy(asc(remoteSessions.id))
        .limit(HOST_REVOCATION_SESSION_BATCH)
        .for("update", { skipLocked: true });
      if (sessions.length > 0) {
        await tx
          .update(remoteSessions)
          .set({ status: "revoked", pairing_token_hash: null, ended_at: now, updated_at: now })
          .where(
            inArray(
              remoteSessions.id,
              sessions.map((session) => session.id),
            ),
          );
      }

      const commands = await tx
        .select({ id: remoteCommandEnvelopes.id, status: remoteCommandEnvelopes.status })
        .from(remoteCommandEnvelopes)
        .where(
          and(
            eq(remoteCommandEnvelopes.host_id, hostId),
            inArray(remoteCommandEnvelopes.status, ["pending", "claimed", "started"]),
          ),
        )
        .orderBy(asc(remoteCommandEnvelopes.id))
        .limit(HOST_REVOCATION_COMMAND_BATCH)
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

      const [remainingSession] = await tx
        .select({ id: remoteSessions.id })
        .from(remoteSessions)
        .where(
          and(
            eq(remoteSessions.host_id, hostId),
            inArray(remoteSessions.status, ["pending", "active"]),
          ),
        )
        .limit(1);
      const [remainingCommand] = await tx
        .select({ id: remoteCommandEnvelopes.id })
        .from(remoteCommandEnvelopes)
        .where(
          and(
            eq(remoteCommandEnvelopes.host_id, hostId),
            inArray(remoteCommandEnvelopes.status, ["pending", "claimed", "started"]),
          ),
        )
        .limit(1);

      return {
        host,
        alreadyRevoked,
        cleanup: {
          sessions: sessions.length,
          commands: commands.length,
          more: Boolean(remainingSession || remainingCommand),
        },
      };
    });
  }
}

export const remoteHostsRepository = new RemoteHostsRepository();
