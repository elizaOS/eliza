/**
 * Persists the application's existing authentication records in the owning agent
 * database. Atomic mutations preserve uniqueness, references and one-use claims;
 * malformed stored records fail closed rather than becoming valid identities.
 */
import { type DurableRecordStore, ElizaError, type UUID } from "@elizaos/core";
import { z } from "zod";
import type {
  AppendAuditEventInput,
  AuthAuditEventRow,
  AuthIdentityRow,
  AuthOwnerBindingRow,
  AuthOwnerLoginTokenRow,
  AuthRepository,
  AuthSessionRow,
  CreateIdentityInput,
  CreateSessionInput,
} from "./auth-store";

const namespaces = {
  identities: "plugin_app_auth_identities_v1",
  sessions: "plugin_app_auth_sessions_v1",
  bindings: "plugin_app_auth_bindings_v1",
  tokens: "plugin_app_auth_login_tokens_v1",
  audit: "plugin_app_auth_audit_v1",
  replay: "plugin_app_auth_replay_v1",
} as const;
const time = z.number().int().nonnegative().safe();
const id = z.string().min(1);
const identity: z.ZodType<AuthIdentityRow> = z
  .object({
    id,
    kind: z.enum(["owner", "machine"]),
    displayName: z.string(),
    createdAt: time,
    passwordHash: z.string().nullable(),
    cloudUserId: z.string().nullable(),
  })
  .strict();
const session: z.ZodType<AuthSessionRow> = z
  .object({
    id,
    identityId: id,
    kind: z.enum(["browser", "machine"]),
    createdAt: time,
    lastSeenAt: time,
    expiresAt: time,
    rememberDevice: z.boolean(),
    csrfSecret: z.string(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    scopes: z.array(z.string()),
    revokedAt: time.nullable(),
  })
  .strict();
const binding: z.ZodType<AuthOwnerBindingRow> = z
  .object({
    id,
    identityId: id,
    connector: z.string(),
    externalId: z.string(),
    displayHandle: z.string(),
    instanceId: z.string(),
    verifiedAt: time,
    pendingCodeHash: z.string().nullable(),
    pendingExpiresAt: time.nullable(),
  })
  .strict();
const token: z.ZodType<AuthOwnerLoginTokenRow> = z
  .object({
    tokenHash: id,
    identityId: id,
    bindingId: id,
    issuedAt: time,
    expiresAt: time,
    consumedAt: time.nullable(),
  })
  .strict();
const audit: z.ZodType<AuthAuditEventRow> = z
  .object({
    id,
    ts: time,
    actorIdentityId: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    action: z.string(),
    outcome: z.enum(["success", "failure"]),
    metadata: z.record(
      z.string(),
      z.union([z.string(), z.number().finite(), z.boolean()]),
    ),
  })
  .strict();
const replay = z.object({ jti: id, seenAt: time }).strict();
function rejected(code: string): ElizaError {
  return new ElizaError(
    "Authentication record storage rejected the operation",
    { code },
  );
}
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw rejected("AUTH_RECORD_INVALID");
  return result.data;
}

export class AuthRecordStore implements AuthRepository {
  constructor(
    private readonly records: DurableRecordStore,
    private readonly agentId: UUID,
  ) {
    this.assertOwner();
  }
  private assertOwner(): void {
    if (this.records.version !== 1 || this.records.agentId !== this.agentId)
      throw rejected("AUTH_RECORD_STORE_AGENT_MISMATCH");
  }
  private atomic<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOwner();
    return this.records.transaction(operation);
  }
  private async read<T>(
    namespace: string,
    schema: z.ZodType<T>,
    key: string,
    keyField: keyof T,
  ): Promise<T | null> {
    const value = await this.records.get<unknown>(namespace, key);
    if (value === null) return null;
    const row = checked(schema, value);
    if (row[keyField] !== key) throw rejected("AUTH_RECORD_KEY_MISMATCH");
    return row;
  }
  private async list<T>(namespace: string, schema: z.ZodType<T>): Promise<T[]> {
    return (await this.records.getAll<unknown>(namespace)).map((row) =>
      checked(schema, row),
    );
  }
  private async insert<T>(
    namespace: string,
    schema: z.ZodType<T>,
    key: string,
    value: T,
  ): Promise<T> {
    const row = checked(schema, value);
    if ((await this.records.get(namespace, key)) !== null)
      throw rejected("AUTH_RECORD_ALREADY_EXISTS");
    await this.records.set(namespace, key, row);
    return row;
  }
  private async requireIdentity(identityId: string): Promise<void> {
    if (!(await this.read(namespaces.identities, identity, identityId, "id")))
      throw rejected("AUTH_RECORD_IDENTITY_MISSING");
  }
  createIdentity(input: CreateIdentityInput): Promise<AuthIdentityRow> {
    return this.atomic(() =>
      this.insert(namespaces.identities, identity, input.id, {
        ...input,
        passwordHash:
          input.passwordHash === undefined ? null : input.passwordHash,
        cloudUserId: input.cloudUserId === undefined ? null : input.cloudUserId,
      }),
    );
  }
  findIdentity(identityId: string): Promise<AuthIdentityRow | null> {
    return this.atomic(() =>
      this.read(namespaces.identities, identity, identityId, "id"),
    );
  }
  findIdentityByCloudUserId(
    cloudUserId: string,
  ): Promise<AuthIdentityRow | null> {
    return this.atomic(
      async () =>
        (await this.list(namespaces.identities, identity)).find(
          (row) => row.cloudUserId === cloudUserId,
        ) ?? null,
    );
  }
  findIdentityByDisplayName(
    displayName: string,
  ): Promise<AuthIdentityRow | null> {
    return this.atomic(
      async () =>
        (await this.list(namespaces.identities, identity)).find(
          (row) => row.displayName === displayName,
        ) ?? null,
    );
  }
  updateIdentityPassword(
    identityId: string,
    passwordHash: string,
  ): Promise<void> {
    return this.atomic(async () => {
      const row = await this.read(
        namespaces.identities,
        identity,
        identityId,
        "id",
      );
      if (row)
        await this.records.set(
          namespaces.identities,
          identityId,
          checked(identity, { ...row, passwordHash }),
        );
    });
  }
  listIdentitiesByKind(kind: "owner" | "machine"): Promise<AuthIdentityRow[]> {
    return this.atomic(async () =>
      (await this.list(namespaces.identities, identity)).filter(
        (row) => row.kind === kind,
      ),
    );
  }
  hasOwnerIdentity(): Promise<boolean> {
    return this.atomic(async () =>
      (await this.list(namespaces.identities, identity)).some(
        (row) => row.kind === "owner",
      ),
    );
  }
  createSession(input: CreateSessionInput): Promise<AuthSessionRow> {
    return this.atomic(async () => {
      await this.requireIdentity(input.identityId);
      return this.insert(namespaces.sessions, session, input.id, {
        ...input,
        revokedAt: null,
      });
    });
  }
  findSession(
    sessionId: string,
    now = Date.now(),
  ): Promise<AuthSessionRow | null> {
    return this.atomic(async () => {
      checked(time, now);
      const row = await this.read(
        namespaces.sessions,
        session,
        sessionId,
        "id",
      );
      return row && row.revokedAt === null && row.expiresAt > now ? row : null;
    });
  }
  revokeSession(sessionId: string, now = Date.now()): Promise<boolean> {
    return this.atomic(async () => {
      checked(time, now);
      const row = await this.read(
        namespaces.sessions,
        session,
        sessionId,
        "id",
      );
      if (!row || row.revokedAt !== null) return false;
      await this.records.set(namespaces.sessions, sessionId, {
        ...row,
        revokedAt: now,
      });
      return true;
    });
  }
  touchSession(
    sessionId: string,
    lastSeenAt: number,
    expiresAt: number,
  ): Promise<void> {
    return this.atomic(async () => {
      checked(time, lastSeenAt);
      checked(time, expiresAt);
      const row = await this.read(
        namespaces.sessions,
        session,
        sessionId,
        "id",
      );
      if (row && row.revokedAt === null)
        await this.records.set(namespaces.sessions, sessionId, {
          ...row,
          lastSeenAt,
          expiresAt,
        });
    });
  }
  revokeAllSessionsForIdentity(
    identityId: string,
    now = Date.now(),
    exceptSessionId?: string,
  ): Promise<number> {
    return this.atomic(async () => {
      checked(time, now);
      let count = 0;
      for (const row of await this.list(namespaces.sessions, session)) {
        if (
          row.identityId === identityId &&
          row.id !== exceptSessionId &&
          row.revokedAt === null
        ) {
          await this.records.set(namespaces.sessions, row.id, {
            ...row,
            revokedAt: now,
          });
          count++;
        }
      }
      return count;
    });
  }
  listSessionsForIdentity(
    identityId: string,
    now = Date.now(),
  ): Promise<AuthSessionRow[]> {
    return this.atomic(async () => {
      checked(time, now);
      return (await this.list(namespaces.sessions, session))
        .filter(
          (row) =>
            row.identityId === identityId &&
            row.revokedAt === null &&
            row.expiresAt > now,
        )
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    });
  }
  recordJtiSeen(jti: string, now = Date.now()): Promise<boolean> {
    return this.atomic(async () => {
      const row = checked(replay, { jti, seenAt: now });
      if (await this.read(namespaces.replay, replay, jti, "jti")) return false;
      await this.records.set(namespaces.replay, jti, row);
      return true;
    });
  }
  pruneJtiSeenBefore(thresholdTs: number): Promise<void> {
    return this.atomic(async () => {
      checked(time, thresholdTs);
      for (const row of await this.list(namespaces.replay, replay))
        if (row.seenAt <= thresholdTs)
          await this.records.delete(namespaces.replay, row.jti);
    });
  }
  appendAuditEvent(input: AppendAuditEventInput): Promise<AuthAuditEventRow> {
    return this.atomic(() =>
      this.insert(namespaces.audit, audit, input.id, input),
    );
  }
  createOwnerBinding(
    input: Parameters<AuthRepository["createOwnerBinding"]>[0],
  ): Promise<void> {
    return this.atomic(async () => {
      await this.requireIdentity(input.identityId);
      if (
        (await this.list(namespaces.bindings, binding)).some(
          (row) =>
            row.connector === input.connector &&
            row.externalId === input.externalId &&
            row.instanceId === input.instanceId,
        )
      )
        throw rejected("AUTH_BINDING_ALREADY_EXISTS");
      await this.insert(namespaces.bindings, binding, input.id, {
        ...input,
        pendingCodeHash:
          input.pendingCodeHash === undefined ? null : input.pendingCodeHash,
        pendingExpiresAt:
          input.pendingExpiresAt === undefined ? null : input.pendingExpiresAt,
      });
    });
  }
  findOwnerBinding(bindingId: string): Promise<AuthOwnerBindingRow | null> {
    return this.atomic(() =>
      this.read(namespaces.bindings, binding, bindingId, "id"),
    );
  }
  findOwnerBindingByPendingCodeHash(
    pendingCodeHash: string,
    instanceId: string,
  ): Promise<AuthOwnerBindingRow | null> {
    return this.atomic(
      async () =>
        (await this.list(namespaces.bindings, binding)).find(
          (row) =>
            row.pendingCodeHash === pendingCodeHash &&
            row.instanceId === instanceId,
        ) ?? null,
    );
  }
  findOwnerBindingByConnectorPair(
    input: Parameters<AuthRepository["findOwnerBindingByConnectorPair"]>[0],
  ): Promise<AuthOwnerBindingRow | null> {
    return this.atomic(
      async () =>
        (await this.list(namespaces.bindings, binding)).find(
          (row) =>
            row.connector === input.connector &&
            row.externalId === input.externalId &&
            row.instanceId === input.instanceId,
        ) ?? null,
    );
  }
  listOwnerBindingsForIdentity(
    identityId: string,
  ): Promise<AuthOwnerBindingRow[]> {
    return this.atomic(async () =>
      (await this.list(namespaces.bindings, binding))
        .filter((row) => row.identityId === identityId)
        .sort((a, b) => b.verifiedAt - a.verifiedAt),
    );
  }
  updateOwnerBindingPending(
    bindingId: string,
    pendingCodeHash: string | null,
    pendingExpiresAt: number | null,
  ): Promise<void> {
    return this.atomic(async () => {
      const row = await this.read(
        namespaces.bindings,
        binding,
        bindingId,
        "id",
      );
      if (row)
        await this.records.set(
          namespaces.bindings,
          bindingId,
          checked(binding, { ...row, pendingCodeHash, pendingExpiresAt }),
        );
    });
  }
  markOwnerBindingVerified(
    bindingId: string,
    verifiedAt: number,
    displayHandle: string,
  ): Promise<void> {
    return this.atomic(async () => {
      const row = await this.read(
        namespaces.bindings,
        binding,
        bindingId,
        "id",
      );
      if (row)
        await this.records.set(
          namespaces.bindings,
          bindingId,
          checked(binding, {
            ...row,
            verifiedAt,
            displayHandle,
            pendingCodeHash: null,
            pendingExpiresAt: null,
          }),
        );
    });
  }
  deleteOwnerBinding(bindingId: string): Promise<boolean> {
    return this.atomic(async () => {
      const deleted = await this.records.delete(namespaces.bindings, bindingId);
      if (deleted)
        for (const row of await this.list(namespaces.tokens, token))
          if (row.bindingId === bindingId)
            await this.records.delete(namespaces.tokens, row.tokenHash);
      return deleted;
    });
  }
  createOwnerLoginToken(
    input: Parameters<AuthRepository["createOwnerLoginToken"]>[0],
  ): Promise<void> {
    return this.atomic(async () => {
      await this.requireIdentity(input.identityId);
      const ownerBinding = await this.read(
        namespaces.bindings,
        binding,
        input.bindingId,
        "id",
      );
      if (!ownerBinding) throw rejected("AUTH_RECORD_BINDING_MISSING");
      if (ownerBinding.identityId !== input.identityId)
        throw rejected("AUTH_RECORD_BINDING_IDENTITY_MISMATCH");
      await this.insert(namespaces.tokens, token, input.tokenHash, {
        ...input,
        consumedAt: null,
      });
    });
  }
  findOwnerLoginToken(
    tokenHash: string,
  ): Promise<AuthOwnerLoginTokenRow | null> {
    return this.atomic(() =>
      this.read(namespaces.tokens, token, tokenHash, "tokenHash"),
    );
  }
  consumeOwnerLoginToken(tokenHash: string, now: number): Promise<boolean> {
    return this.atomic(async () => {
      checked(time, now);
      const row = await this.read(
        namespaces.tokens,
        token,
        tokenHash,
        "tokenHash",
      );
      if (!row || row.consumedAt !== null || row.expiresAt <= now) return false;
      await this.records.set(namespaces.tokens, tokenHash, {
        ...row,
        consumedAt: now,
      });
      return true;
    });
  }
}
