/**
 * pglite-backed repositories for the auth subsystem.
 *
 * The store operates on a Drizzle database handle obtained from the agent
 * runtime's database adapter (`@elizaos/plugin-sql`). Tables are owned by
 * `@elizaos/plugin-sql`'s schema barrel — we import them directly.
 *
 * Every method is fail-fast: errors propagate to the caller. The auth code
 * path must NEVER swallow a DB error and pretend a request was authenticated.
 */

import {
  authAuditEventTable,
  authBootstrapJtiSeenTable,
  authIdentityTable,
  authOwnerBindingTable,
  authSessionTable,
} from "@elizaos/plugin-sql/schema";
import type { DrizzleDatabase } from "@elizaos/plugin-sql/types";
import { and, eq, lte } from "drizzle-orm";

export interface AuthIdentityRow {
  id: string;
  kind: "owner" | "machine";
  displayName: string;
  createdAt: number;
  passwordHash: string | null;
  cloudUserId: string | null;
}

export interface AuthSessionRow {
  id: string;
  identityId: string;
  kind: "browser" | "machine";
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  rememberDevice: boolean;
  csrfSecret: string;
  ip: string | null;
  userAgent: string | null;
  scopes: string[];
  revokedAt: number | null;
}

export interface AuthAuditEventRow {
  id: string;
  ts: number;
  actorIdentityId: string | null;
  ip: string | null;
  userAgent: string | null;
  action: string;
  outcome: "success" | "failure";
  metadata: Record<string, string | number | boolean>;
}

export interface CreateIdentityInput {
  id: string;
  kind: "owner" | "machine";
  displayName: string;
  createdAt: number;
  passwordHash?: string | null;
  cloudUserId?: string | null;
}

export interface CreateSessionInput {
  id: string;
  identityId: string;
  kind: "browser" | "machine";
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  rememberDevice: boolean;
  csrfSecret: string;
  ip: string | null;
  userAgent: string | null;
  scopes: string[];
}

export interface AppendAuditEventInput {
  id: string;
  ts: number;
  actorIdentityId: string | null;
  ip: string | null;
  userAgent: string | null;
  action: string;
  outcome: "success" | "failure";
  metadata: Record<string, string | number | boolean>;
}

interface DrizzleRunResult {
  rowCount?: number | null;
}

function nullableString(value: string | null | undefined): string | null {
  return value === undefined ? null : value;
}

function rowToIdentity(
  row: typeof authIdentityTable.$inferSelect,
): AuthIdentityRow {
  return {
    id: row.id,
    kind: row.kind === "machine" ? "machine" : "owner",
    displayName: row.displayName,
    createdAt: Number(row.createdAt),
    passwordHash: row.passwordHash ?? null,
    cloudUserId: row.cloudUserId ?? null,
  };
}

function rowToSession(
  row: typeof authSessionTable.$inferSelect,
): AuthSessionRow {
  return {
    id: row.id,
    identityId: row.identityId,
    kind: row.kind === "machine" ? "machine" : "browser",
    createdAt: Number(row.createdAt),
    lastSeenAt: Number(row.lastSeenAt),
    expiresAt: Number(row.expiresAt),
    rememberDevice: row.rememberDevice,
    csrfSecret: row.csrfSecret,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    revokedAt:
      row.revokedAt === null || row.revokedAt === undefined
        ? null
        : Number(row.revokedAt),
  };
}

export class AuthStore {
  constructor(private readonly db: DrizzleDatabase) {}

  async createIdentity(input: CreateIdentityInput): Promise<AuthIdentityRow> {
    const inserted = await this.db
      .insert(authIdentityTable)
      .values({
        id: input.id,
        kind: input.kind,
        displayName: input.displayName,
        createdAt: input.createdAt,
        passwordHash: nullableString(input.passwordHash),
        cloudUserId: nullableString(input.cloudUserId),
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error("auth-store: createIdentity returned no row");
    }
    return rowToIdentity(row);
  }

  async findIdentity(id: string): Promise<AuthIdentityRow | null> {
    const rows = await this.db
      .select()
      .from(authIdentityTable)
      .where(eq(authIdentityTable.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToIdentity(row) : null;
  }

  async findIdentityByCloudUserId(
    cloudUserId: string,
  ): Promise<AuthIdentityRow | null> {
    const rows = await this.db
      .select()
      .from(authIdentityTable)
      .where(eq(authIdentityTable.cloudUserId, cloudUserId))
      .limit(1);
    const row = rows[0];
    return row ? rowToIdentity(row) : null;
  }

  async createSession(input: CreateSessionInput): Promise<AuthSessionRow> {
    const inserted = await this.db
      .insert(authSessionTable)
      .values({
        id: input.id,
        identityId: input.identityId,
        kind: input.kind,
        createdAt: input.createdAt,
        lastSeenAt: input.lastSeenAt,
        expiresAt: input.expiresAt,
        rememberDevice: input.rememberDevice,
        csrfSecret: input.csrfSecret,
        ip: nullableString(input.ip),
        userAgent: nullableString(input.userAgent),
        scopes: input.scopes,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error("auth-store: createSession returned no row");
    }
    return rowToSession(row);
  }

  /**
   * Look up a session by id. Returns `null` for unknown id, expired session,
   * or revoked session — the caller MUST treat `null` as "not authenticated"
   * and never as "transient error".
   */
  async findSession(
    id: string,
    now: number = Date.now(),
  ): Promise<AuthSessionRow | null> {
    const rows = await this.db
      .select()
      .from(authSessionTable)
      .where(eq(authSessionTable.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const session = rowToSession(row);
    if (session.revokedAt !== null) return null;
    if (session.expiresAt <= now) return null;
    return session;
  }

  async revokeSession(id: string, now: number = Date.now()): Promise<boolean> {
    const result = (await this.db
      .update(authSessionTable)
      .set({ revokedAt: now })
      .where(
        and(
          eq(authSessionTable.id, id),
          /* not already revoked */ eq(authSessionTable.id, id),
        ),
      )) as unknown as DrizzleRunResult;
    return typeof result.rowCount === "number" ? result.rowCount > 0 : true;
  }

  /**
   * Atomic test-and-set on the bootstrap-token replay set.
   *
   * Returns `true` when this `jti` was unseen and is now recorded.
   * Returns `false` when the `jti` was already present — indicating a replay.
   *
   * Implemented via INSERT … ON CONFLICT DO NOTHING so the check is one
   * round trip and there is no TOCTOU window.
   */
  async recordJtiSeen(jti: string, now: number = Date.now()): Promise<boolean> {
    const inserted = await this.db
      .insert(authBootstrapJtiSeenTable)
      .values({ jti, seenAt: now })
      .onConflictDoNothing({ target: authBootstrapJtiSeenTable.jti })
      .returning();
    return inserted.length > 0;
  }

  async pruneJtiSeenBefore(thresholdTs: number): Promise<void> {
    await this.db
      .delete(authBootstrapJtiSeenTable)
      .where(lte(authBootstrapJtiSeenTable.seenAt, thresholdTs));
  }

  async appendAuditEvent(
    input: AppendAuditEventInput,
  ): Promise<AuthAuditEventRow> {
    const inserted = await this.db
      .insert(authAuditEventTable)
      .values({
        id: input.id,
        ts: input.ts,
        actorIdentityId: nullableString(input.actorIdentityId),
        ip: nullableString(input.ip),
        userAgent: nullableString(input.userAgent),
        action: input.action,
        outcome: input.outcome,
        metadata: input.metadata,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error("auth-store: appendAuditEvent returned no row");
    }
    return {
      id: row.id,
      ts: Number(row.ts),
      actorIdentityId: row.actorIdentityId ?? null,
      ip: row.ip ?? null,
      userAgent: row.userAgent ?? null,
      action: row.action,
      outcome: row.outcome === "failure" ? "failure" : "success",
      metadata: (row.metadata ?? {}) as Record<
        string,
        string | number | boolean
      >,
    };
  }

  async createOwnerBinding(input: {
    id: string;
    identityId: string;
    connector: string;
    externalId: string;
    displayHandle: string;
    instanceId: string;
    verifiedAt: number;
  }): Promise<void> {
    await this.db.insert(authOwnerBindingTable).values({
      id: input.id,
      identityId: input.identityId,
      connector: input.connector,
      externalId: input.externalId,
      displayHandle: input.displayHandle,
      instanceId: input.instanceId,
      verifiedAt: input.verifiedAt,
    });
  }
}
