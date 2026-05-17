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
type AuthSqlRow = Record<string, unknown>;
interface AuthSqlReturningBuilder {
  returning(): Promise<AuthSqlRow[]>;
}
interface AuthSqlInsertBuilder extends AuthSqlReturningBuilder {
  values(value: unknown): AuthSqlInsertBuilder;
  onConflictDoNothing(config: unknown): AuthSqlReturningBuilder;
}
interface AuthSqlLimitedSelectBuilder {
  limit(limit: number): Promise<AuthSqlRow[]>;
}
interface AuthSqlOrderedSelectBuilder {
  orderBy(order: unknown): Promise<AuthSqlRow[]>;
}
interface AuthSqlWhereSelectBuilder
  extends AuthSqlLimitedSelectBuilder,
    AuthSqlOrderedSelectBuilder,
    PromiseLike<AuthSqlRow[]> {}
interface AuthSqlFromSelectBuilder {
  where(condition: unknown): AuthSqlWhereSelectBuilder;
}
interface AuthSqlSelectBuilder {
  from(table: unknown): AuthSqlFromSelectBuilder;
}
interface AuthSqlUpdateBuilder {
  set(value: unknown): {
    where(condition: unknown): Promise<unknown>;
  };
}
interface AuthSqlDeleteBuilder {
  where(condition: unknown): Promise<unknown>;
}
export interface DrizzleDatabase {
  insert(table: unknown): AuthSqlInsertBuilder;
  select(selection?: unknown): AuthSqlSelectBuilder;
  update(table: unknown): AuthSqlUpdateBuilder;
  delete(table: unknown): AuthSqlDeleteBuilder;
}
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
export declare class AuthStore {
  private readonly db;
  constructor(db: DrizzleDatabase);
  createIdentity(input: CreateIdentityInput): Promise<AuthIdentityRow>;
  findIdentity(id: string): Promise<AuthIdentityRow | null>;
  findIdentityByCloudUserId(
    cloudUserId: string,
  ): Promise<AuthIdentityRow | null>;
  findIdentityByDisplayName(
    displayName: string,
  ): Promise<AuthIdentityRow | null>;
  updateIdentityPassword(id: string, passwordHash: string): Promise<void>;
  listIdentitiesByKind(kind: "owner" | "machine"): Promise<AuthIdentityRow[]>;
  hasOwnerIdentity(): Promise<boolean>;
  createSession(input: CreateSessionInput): Promise<AuthSessionRow>;
  /**
   * Look up a session by id. Returns `null` for unknown id, expired session,
   * or revoked session — the caller MUST treat `null` as "not authenticated"
   * and never as "transient error".
   */
  findSession(id: string, now?: number): Promise<AuthSessionRow | null>;
  revokeSession(id: string, now?: number): Promise<boolean>;
  /**
   * Slide the browser session forward: bump `lastSeenAt` and extend
   * `expiresAt`. Caller computes the new `expiresAt` so the store stays
   * policy-free.
   */
  touchSession(
    id: string,
    lastSeenAt: number,
    expiresAt: number,
  ): Promise<void>;
  /**
   * Revoke every active session for an identity, except optionally the one
   * currently in use. Returns the number of rows updated. Implemented in a
   * single statement — no read/write race window.
   */
  revokeAllSessionsForIdentity(
    identityId: string,
    now?: number,
    exceptSessionId?: string,
  ): Promise<number>;
  /**
   * List every active (unrevoked, unexpired) session for an identity, newest
   * first. Used by `/api/auth/sessions` to populate the security UI.
   */
  listSessionsForIdentity(
    identityId: string,
    now?: number,
  ): Promise<AuthSessionRow[]>;
  /**
   * Atomic test-and-set on the bootstrap-token replay set.
   *
   * Returns `true` when this `jti` was unseen and is now recorded.
   * Returns `false` when the `jti` was already present — indicating a replay.
   *
   * Implemented via INSERT … ON CONFLICT DO NOTHING so the check is one
   * round trip and there is no TOCTOU window.
   */
  recordJtiSeen(jti: string, now?: number): Promise<boolean>;
  pruneJtiSeenBefore(thresholdTs: number): Promise<void>;
  appendAuditEvent(input: AppendAuditEventInput): Promise<AuthAuditEventRow>;
  createOwnerBinding(input: {
    id: string;
    identityId: string;
    connector: string;
    externalId: string;
    displayHandle: string;
    instanceId: string;
    verifiedAt: number;
    pendingCodeHash?: string | null;
    pendingExpiresAt?: number | null;
  }): Promise<void>;
  findOwnerBinding(id: string): Promise<AuthOwnerBindingRow | null>;
  findOwnerBindingByPendingCodeHash(
    pendingCodeHash: string,
    instanceId: string,
  ): Promise<AuthOwnerBindingRow | null>;
  findOwnerBindingByConnectorPair(input: {
    connector: string;
    externalId: string;
    instanceId: string;
  }): Promise<AuthOwnerBindingRow | null>;
  listOwnerBindingsForIdentity(
    identityId: string,
  ): Promise<AuthOwnerBindingRow[]>;
  updateOwnerBindingPending(
    id: string,
    pendingCodeHash: string | null,
    pendingExpiresAt: number | null,
  ): Promise<void>;
  markOwnerBindingVerified(
    id: string,
    verifiedAt: number,
    displayHandle: string,
  ): Promise<void>;
  deleteOwnerBinding(id: string): Promise<boolean>;
  createOwnerLoginToken(input: {
    tokenHash: string;
    identityId: string;
    bindingId: string;
    issuedAt: number;
    expiresAt: number;
  }): Promise<void>;
  findOwnerLoginToken(
    tokenHash: string,
  ): Promise<AuthOwnerLoginTokenRow | null>;
  /**
   * Atomically mark the token as consumed. Returns true when the consume
   * succeeded (token existed, was unconsumed, was unexpired). Returns
   * false otherwise — the caller MUST treat false as "auth failure" and
   * never as "transient error".
   */
  consumeOwnerLoginToken(tokenHash: string, now: number): Promise<boolean>;
}
//# sourceMappingURL=auth-store.d.ts.map
