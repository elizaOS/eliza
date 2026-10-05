/** Authentication records and atomic operations shared by the existing storage adapters. */
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

export interface AuthRepository {
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
  findSession(id: string, now?: number): Promise<AuthSessionRow | null>;
  revokeSession(id: string, now?: number): Promise<boolean>;
  touchSession(
    id: string,
    lastSeenAt: number,
    expiresAt: number,
  ): Promise<void>;
  revokeAllSessionsForIdentity(
    identityId: string,
    now?: number,
    exceptSessionId?: string,
  ): Promise<number>;
  listSessionsForIdentity(
    identityId: string,
    now?: number,
  ): Promise<AuthSessionRow[]>;
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
  consumeOwnerLoginToken(tokenHash: string, now: number): Promise<boolean>;
}
