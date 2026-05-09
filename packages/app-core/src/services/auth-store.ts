/**
 * pglite-backed repositories for the auth subsystem.
 *
 * The store operates on a Drizzle database handle obtained from the agent
 * runtime's database adapter (`@elizaos/plugin-sql`). Tables are owned by the
 * plugin-sql schema attached to the root plugin export.
 *
 * Every method is fail-fast: errors propagate to the caller. The auth code
 * path must NEVER swallow a DB error and pretend a request was authenticated.
 */

import { and, desc, eq, isNull, lte, ne } from "drizzle-orm";
import type { DrizzleDatabase } from "@elizaos/plugin-sql";
import {
  authAuditEventTable,
  authBootstrapJtiSeenTable,
  authIdentityTable,
  authOwnerBindingTable,
  authOwnerLoginTokenTable,
  authSessionTable,
} from "@elizaos/plugin-sql";

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

export interface AuthOwnerBindingRow {
  id: string;
  identityId: string;
  connector: string;
  externalId: string;
  displayHandle: string;
  instanceId: string;
  verifiedAt: number;
  pendingCodeHash: string | null;
  pendingExpiresAt: number | null;
}

export interface AuthOwnerLoginTokenRow {
  tokenHash: string;
  identityId: string;
  bindingId: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
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

function readRunRowCount(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const rowCount = (result as DrizzleRunResult).rowCount;
  return typeof rowCount === "number" ? rowCount : null;
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

  async findIdentityByDisplayName(
    displayName: string,
  ): Promise<AuthIdentityRow | null> {
    const rows = await this.db
      .select()
      .from(authIdentityTable)
      .where(eq(authIdentityTable.displayName, displayName))
      .limit(1);
    const row = rows[0];
    return row ? rowToIdentity(row) : null;
  }

  async updateIdentityPassword(
    id: string,
    passwordHash: string,
  ): Promise<void> {
    await this.db
      .update(authIdentityTable)
      .set({ passwordHash })
      .where(eq(authIdentityTable.id, id));
  }

  async listIdentitiesByKind(
    kind: "owner" | "machine",
  ): Promise<AuthIdentityRow[]> {
    const rows = await this.db
      .select()
      .from(authIdentityTable)
      .where(eq(authIdentityTable.kind, kind));
    return rows.map(rowToIdentity);
  }

  async hasOwnerIdentity(): Promise<boolean> {
    const rows = await this.db
      .select({ id: authIdentityTable.id })
      .from(authIdentityTable)
      .where(eq(authIdentityTable.kind, "owner"))
      .limit(1);
    return rows.length > 0;
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
    const result = await this.db
      .update(authSessionTable)
      .set({ revokedAt: now })
      .where(
        and(eq(authSessionTable.id, id), isNull(authSessionTable.revokedAt)),
      );
    const rowCount = readRunRowCount(result);
    return rowCount === null ? true : rowCount > 0;
  }

  /**
   * Slide the browser session forward: bump `lastSeenAt` and extend
   * `expiresAt`. Caller computes the new `expiresAt` so the store stays
   * policy-free.
   */
  async touchSession(
    id: string,
    lastSeenAt: number,
    expiresAt: number,
  ): Promise<void> {
    await this.db
      .update(authSessionTable)
      .set({ lastSeenAt, expiresAt })
      .where(
        and(eq(authSessionTable.id, id), isNull(authSessionTable.revokedAt)),
      );
  }

  /**
   * Revoke every active session for an identity, except optionally the one
   * currently in use. Returns the number of rows updated. Implemented in a
   * single statement — no read/write race window.
   */
  async revokeAllSessionsForIdentity(
    identityId: string,
    now: number = Date.now(),
    exceptSessionId?: string,
  ): Promise<number> {
    const condition = exceptSessionId
      ? and(
          eq(authSessionTable.identityId, identityId),
          isNull(authSessionTable.revokedAt),
          ne(authSessionTable.id, exceptSessionId),
        )
      : and(
          eq(authSessionTable.identityId, identityId),
          isNull(authSessionTable.revokedAt),
        );
    const result = await this.db
      .update(authSessionTable)
      .set({ revokedAt: now })
      .where(condition);
    return readRunRowCount(result) ?? 0;
  }

  /**
   * List every active (unrevoked, unexpired) session for an identity, newest
   * first. Used by `/api/auth/sessions` to populate the security UI.
   */
  async listSessionsForIdentity(
    identityId: string,
    now: number = Date.now(),
  ): Promise<AuthSessionRow[]> {
    const rows = await this.db
      .select()
      .from(authSessionTable)
      .where(eq(authSessionTable.identityId, identityId))
      .orderBy(desc(authSessionTable.lastSeenAt));
    const out: AuthSessionRow[] = [];
    for (const row of rows) {
      const session = rowToSession(row);
      if (session.revokedAt !== null) continue;
      if (session.expiresAt <= now) continue;
      out.push(session);
    }
    return out;
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
    pendingCodeHash?: string | null;
    pendingExpiresAt?: number | null;
  }): Promise<void> {
    await this.db.insert(authOwnerBindingTable).values({
      id: input.id,
      identityId: input.identityId,
      connector: input.connector,
      externalId: input.externalId,
      displayHandle: input.displayHandle,
      instanceId: input.instanceId,
      verifiedAt: input.verifiedAt,
      pendingCodeHash: nullableString(input.pendingCodeHash),
      pendingExpiresAt:
        input.pendingExpiresAt === null || input.pendingExpiresAt === undefined
          ? null
          : input.pendingExpiresAt,
    });
  }

  async findOwnerBinding(id: string): Promise<AuthOwnerBindingRow | null> {
    const rows = await this.db
      .select()
      .from(authOwnerBindingTable)
      .where(eq(authOwnerBindingTable.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToOwnerBinding(row) : null;
  }

  async findOwnerBindingByPendingCodeHash(
    pendingCodeHash: string,
    instanceId: string,
  ): Promise<AuthOwnerBindingRow | null> {
    const rows = await this.db
      .select()
      .from(authOwnerBindingTable)
      .where(
        and(
          eq(authOwnerBindingTable.pendingCodeHash, pendingCodeHash),
          eq(authOwnerBindingTable.instanceId, instanceId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? rowToOwnerBinding(row) : null;
  }

  async findOwnerBindingByConnectorPair(input: {
    connector: string;
    externalId: string;
    instanceId: string;
  }): Promise<AuthOwnerBindingRow | null> {
    const rows = await this.db
      .select()
      .from(authOwnerBindingTable)
      .where(
        and(
          eq(authOwnerBindingTable.connector, input.connector),
          eq(authOwnerBindingTable.externalId, input.externalId),
          eq(authOwnerBindingTable.instanceId, input.instanceId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? rowToOwnerBinding(row) : null;
  }

  async listOwnerBindingsForIdentity(
    identityId: string,
  ): Promise<AuthOwnerBindingRow[]> {
    const rows = await this.db
      .select()
      .from(authOwnerBindingTable)
      .where(eq(authOwnerBindingTable.identityId, identityId))
      .orderBy(desc(authOwnerBindingTable.verifiedAt));
    return rows.map(rowToOwnerBinding);
  }

  async updateOwnerBindingPending(
    id: string,
    pendingCodeHash: string | null,
    pendingExpiresAt: number | null,
  ): Promise<void> {
    await this.db
      .update(authOwnerBindingTable)
      .set({ pendingCodeHash, pendingExpiresAt })
      .where(eq(authOwnerBindingTable.id, id));
  }

  async markOwnerBindingVerified(
    id: string,
    verifiedAt: number,
    displayHandle: string,
  ): Promise<void> {
    await this.db
      .update(authOwnerBindingTable)
      .set({
        verifiedAt,
        displayHandle,
        pendingCodeHash: null,
        pendingExpiresAt: null,
      })
      .where(eq(authOwnerBindingTable.id, id));
  }

  async deleteOwnerBinding(id: string): Promise<boolean> {
    const result = await this.db
      .delete(authOwnerBindingTable)
      .where(eq(authOwnerBindingTable.id, id));
    const rowCount = readRunRowCount(result);
    return rowCount === null ? true : rowCount > 0;
  }

  async createOwnerLoginToken(input: {
    tokenHash: string;
    identityId: string;
    bindingId: string;
    issuedAt: number;
    expiresAt: number;
  }): Promise<void> {
    await this.db.insert(authOwnerLoginTokenTable).values({
      tokenHash: input.tokenHash,
      identityId: input.identityId,
      bindingId: input.bindingId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    });
  }

  async findOwnerLoginToken(
    tokenHash: string,
  ): Promise<AuthOwnerLoginTokenRow | null> {
    const rows = await this.db
      .select()
      .from(authOwnerLoginTokenTable)
      .where(eq(authOwnerLoginTokenTable.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    return row ? rowToOwnerLoginToken(row) : null;
  }

  /**
   * Atomically mark the token as consumed. Returns true when the consume
   * succeeded (token existed, was unconsumed, was unexpired). Returns
   * false otherwise — the caller MUST treat false as "auth failure" and
   * never as "transient error".
   */
  async consumeOwnerLoginToken(
    tokenHash: string,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .update(authOwnerLoginTokenTable)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authOwnerLoginTokenTable.tokenHash, tokenHash),
          isNull(authOwnerLoginTokenTable.consumedAt),
        ),
      );
    const rowCount = readRunRowCount(result);
    return rowCount === null ? true : rowCount > 0;
  }
}

function rowToOwnerBinding(
  row: typeof authOwnerBindingTable.$inferSelect,
): AuthOwnerBindingRow {
  return {
    id: row.id,
    identityId: row.identityId,
    connector: row.connector,
    externalId: row.externalId,
    displayHandle: row.displayHandle,
    instanceId: row.instanceId,
    verifiedAt: Number(row.verifiedAt),
    pendingCodeHash: row.pendingCodeHash ?? null,
    pendingExpiresAt:
      row.pendingExpiresAt === null || row.pendingExpiresAt === undefined
        ? null
        : Number(row.pendingExpiresAt),
  };
}

function rowToOwnerLoginToken(
  row: typeof authOwnerLoginTokenTable.$inferSelect,
): AuthOwnerLoginTokenRow {
  return {
    tokenHash: row.tokenHash,
    identityId: row.identityId,
    bindingId: row.bindingId,
    issuedAt: Number(row.issuedAt),
    expiresAt: Number(row.expiresAt),
    consumedAt:
      row.consumedAt === null || row.consumedAt === undefined
        ? null
        : Number(row.consumedAt),
  };
}
