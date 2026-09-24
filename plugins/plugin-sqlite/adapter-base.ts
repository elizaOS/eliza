/**
 * Provides durable per-agent runtime records with atomic public operations.
 * Collection behavior is shared with the storage-neutral adapter; the transient
 * vector index is rebuilt before readers resume after restart or rollback.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  AppendConnectorAccountAuditEventParams,
  ConnectorAccountAuditEventRecord,
  ConnectorAccountAuditOutcome,
  ConnectorAccountCredentialRefRecord,
  ConnectorAccountJsonObject,
  ConnectorAccountRecord,
  ConsumeOAuthFlowStateParams,
  CreateOAuthFlowStateParams,
  DeleteConnectorAccountCredentialRefsParams,
  DeleteConnectorAccountParams,
  DeleteOAuthFlowStateParams,
  DurableRecordStore,
  GetConnectorAccountCredentialRefParams,
  GetConnectorAccountParams,
  GetOAuthFlowStateParams,
  IDatabaseAdapter,
  JsonValue,
  ListConnectorAccountCredentialRefsParams,
  ListConnectorAccountsParams,
  Memory,
  OAuthFlowRecord,
  PluginSchema,
  SetConnectorAccountCredentialRefParams,
  UpdateOAuthFlowStateParams,
  UpsertConnectorAccountParams,
  UUID,
} from "@elizaos/core";
import {
  cloneConnectorJsonObject,
  ElizaError,
  redactConnectorJsonAudit,
} from "@elizaos/core";
import {
  COLLECTIONS,
  type IStorage,
} from "./types";
import { SQLiteRecordAdapter } from "./records";
import { SQLiteStorageBase } from "./storage-base";
import type { SQLiteDriver } from "./sqlite-driver-types";

function randomUuid(): UUID {
  return randomUUID() as UUID;
}
async function sha256Hex(value: string): Promise<string> {
  return createHash("sha256").update(value).digest("hex");
}
function connectorAccountKey(params: {
  agentId: UUID;
  provider: string;
  accountKey: string;
}): string {
  return JSON.stringify([params.agentId, params.provider, params.accountKey]);
}

function connectorCredentialKey(params: {
  accountId: UUID;
  credentialType: string;
}): string {
  return JSON.stringify([params.accountId, params.credentialType]);
}

function oauthFlowKey(params: {
  agentId: UUID;
  provider: string;
  stateHash: string;
}): string {
  return JSON.stringify([params.agentId, params.provider, params.stateHash]);
}

function connectorDateToMillis(
  value: number | Date | null | undefined,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : value;
}

const CONNECTOR_AUDIT_SECRET_KEY_PATTERN =
  /(access|refresh|id)?_?token|secret|password|credential|authorization|cookie|code[_-]?verifier|codeVerifier|client[_-]?secret|api_?key|private_?key|oauth_?code|state/i;

function redactConnectorAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): ConnectorAccountJsonObject {
  return redactConnectorJsonAudit(metadata, (key) =>
    CONNECTOR_AUDIT_SECRET_KEY_PATTERN.test(key),
  );
}

export class SQLiteAdapterBase extends SQLiteRecordAdapter {
  readonly recordStore: DurableRecordStore;
  private readonly sqlite: SQLiteStorageBase;
  private readonly connectorAccountsById;
  private readonly connectorAccountIdsByKey;
  private readonly connectorCredentialRefs;
  private readonly connectorAuditEvents;
  private readonly oauthFlowsByStateHash;

  private facade: SQLiteAdapterBase = this;

  protected static driver: SQLiteDriver;

  constructor(path: string, agentId: UUID) {
    const storage = new SQLiteStorageBase(path, agentId, (new.target as typeof SQLiteAdapterBase).driver);
    super(storage, agentId);
    this.sqlite = storage;
    const namespace = (value: string): string => {
      if (!/^plugin_[a-z0-9_]+$/.test(value))
        throw new ElizaError(
          "Domain record namespaces must use the plugin_ prefix and lowercase identifiers",
          { code: "SQLITE_RECORD_NAMESPACE_INVALID" },
        );
      return value;
    };
    this.recordStore = {
      version: 1,
      agentId,
      transaction: <T>(operation: () => Promise<T>) =>
        storage.transaction(operation, () => this.rebuildIndex()),
      get: <T>(name: string, key: string) =>
        storage.get<T>(namespace(name), key),
      getAll: <T>(name: string) => storage.getAll<T>(namespace(name)),
      set: <T>(name: string, key: string, value: T) =>
        storage.set(namespace(name), key, value),
      delete: (name: string, key: string) =>
        storage.delete(namespace(name), key),
    };
    this.connectorAccountsById =
      storage.collection<ConnectorAccountRecord>("connector_accounts");
    this.connectorAccountIdsByKey = storage.collection<string>(
      "connector_account_keys",
    );
    this.connectorCredentialRefs =
      storage.collection<ConnectorAccountCredentialRefRecord>(
        "connector_credentials",
      );
    this.connectorAuditEvents =
      storage.collection<ConnectorAccountAuditEventRecord>("connector_audit");
    this.oauthFlowsByStateHash =
      storage.collection<OAuthFlowRecord>("oauth_flows");
    const adapter = this;
    // Central interception makes inherited multi-write batches atomic too. Calls
    // within a method use the target and remain within that operation's owner.
    const lifecycle = new Set([
      "constructor",
      "initialize",
      "init",
      "close",
      "isReady",
      "getConnection",
      "transaction",
      "backup",
    ]);
    const facade = new Proxy(adapter, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (typeof property !== "string" || lifecycle.has(property))
          return value.bind(target);
        return (...args: unknown[]) =>
          storage.operation(
            async () => {
              target.validateAgentArguments(args, property);
              return Reflect.apply(value, target, args);
            },
            () => target.rebuildIndex(),
          );
      },
    });
    adapter.facade = facade;
    return facade;
  }

  static create<T extends SQLiteAdapterBase>(
    this: new (path: string, agentId: UUID) => T,
    path: string,
    agentId: UUID,
  ): T {
    return new this(path, agentId);
  }

  private validateAgentArguments(args: unknown[], method: string): void {
    const records = args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg]));
    for (const arg of records) {
      if (typeof arg !== "object" || arg === null) continue;
      if (
        (method === "createAgents" || method === "upsertAgents") &&
        (!("id" in arg) || arg.id !== this.sqlite.agentId)
      ) {
        throw new ElizaError(
          "SQLite agent records must use the database owner id",
          { code: "SQLITE_AGENT_MISMATCH" },
        );
      }
      const inputs: object[] = [arg];
      for (const key of ["memory", "agent", "task", "updates"] as const) {
        if (key in arg) {
          const value = Reflect.get(arg, key);
          if (typeof value === "object" && value !== null) inputs.push(value);
        }
      }
      for (const input of inputs) {
        if (
          "agentId" in input &&
          input.agentId !== undefined &&
          input.agentId !== this.sqlite.agentId
        ) {
          throw new ElizaError("SQLite operation targets another agent", {
            code: "SQLITE_AGENT_MISMATCH",
          });
        }
      }
      if (
        method === "updateAgents" &&
        "agent" in arg &&
        typeof arg.agent === "object" &&
        arg.agent !== null &&
        "id" in arg.agent &&
        arg.agent.id !== this.sqlite.agentId
      ) {
        throw new ElizaError(
          "SQLite agent update cannot change database ownership",
          { code: "SQLITE_AGENT_MISMATCH" },
        );
      }
    }
  }

  override async initialize(): Promise<void> {
    await this.sqlite.init();
    await this.sqlite.transaction(async () => {
      const dimension = await this.sqlite.get<number>(
        "adapter_metadata",
        "embedding_dimension",
      );
      if (dimension !== null) this.embeddingDimension = dimension;
      await this.rebuildIndex();
      this.ready = true;
    });
  }

  override async close(): Promise<void> {
    await this.sqlite.close(async () => {
      await this.vectorIndex.clear();
      this.ready = false;
    });
  }

  private async rebuildIndex(): Promise<void> {
    const savedDimension = await this.sqlite.get<number>(
      "adapter_metadata",
      "embedding_dimension",
    );
    this.embeddingDimension = savedDimension === null ? 384 : savedDimension;
    await this.vectorIndex.clear();
    await this.vectorIndex.init(this.embeddingDimension);
    const memories = await this.sqlite.getAll<Memory>(COLLECTIONS.MEMORIES);
    for (const memory of memories) {
      if (memory.id && memory.embedding?.length === this.embeddingDimension)
        await this.vectorIndex.add(memory.id, memory.embedding);
    }
  }

  override async ensureEmbeddingDimension(dimension: number): Promise<void> {
    if (!Number.isSafeInteger(dimension) || dimension <= 0)
      throw new ElizaError("Embedding dimension must be a positive integer", {
        code: "SQLITE_EMBEDDING_DIMENSION_INVALID",
      });
    await super.ensureEmbeddingDimension(dimension);
    await this.sqlite.set("adapter_metadata", "embedding_dimension", dimension);
    await this.rebuildIndex();
  }

  protected override cacheStorageKey(key: string): string {
    // The persistent file already enforces one owner; retain its on-disk keys.
    return key;
  }

  override async withAgentScope<T>(
    agentId: UUID,
    callback: (scoped: IDatabaseAdapter<IStorage>) => Promise<T>,
  ): Promise<T> {
    if (agentId !== this.sqlite.agentId) {
      throw new ElizaError(
        "Import a new agent into its own SQLite database file",
        {
          code: "SQLITE_AGENT_MISMATCH",
        },
      );
    }
    return this.transaction(callback);
  }

  override async transaction<T>(
    callback: (tx: IDatabaseAdapter<IStorage>) => Promise<T>,
    options?: { entityContext?: UUID },
  ): Promise<T> {
    if (options?.entityContext)
      throw new ElizaError(
        "SQLite does not implement PostgreSQL row-level security; use document access controls",
        { code: "SQLITE_ENTITY_TRANSACTION_UNSUPPORTED" },
      );
    return this.sqlite.transaction(
      () => callback(this.facade),
      () => this.rebuildIndex(),
    );
  }

  override async runPluginMigrations(
    plugins: Array<{ name: string; schema?: Record<string, JsonValue> }>,
  ): Promise<void> {
    const incompatible = plugins
      .filter(
        (plugin) => plugin.schema && Object.keys(plugin.schema).length > 0,
      )
      .map((plugin) => plugin.name);
    if (incompatible.length > 0)
      throw new ElizaError(
        "PostgreSQL plugin schemas require a SQLite migration before activation",
        {
          code: "SQLITE_PLUGIN_SCHEMA_UNSUPPORTED",
          context: { plugins: incompatible },
        },
      );
  }

  async registerPluginSchema(schema: PluginSchema): Promise<void> {
    throw new ElizaError(
      "Plugin schema requires an explicit SQLite migration",
      {
        code: "SQLITE_PLUGIN_SCHEMA_UNSUPPORTED",
        context: { plugin: schema.pluginName },
      },
    );
  }

  async backup(destination: string): Promise<void> {
    await this.sqlite.backup(destination);
  }
  async listConnectorAccounts(
    params: ListConnectorAccountsParams = {},
  ): Promise<ConnectorAccountRecord[]> {
    const agentId = params.agentId ?? this.sqlite.agentId;
    const offset = params.offset ?? 0;
    const accounts = Array.from(this.connectorAccountsById.values())
      .filter((account) => account.agentId === agentId)
      .filter((account) => account.deletedAt == null)
      .filter(
        (account) => !params.provider || account.provider === params.provider,
      )
      .filter((account) => !params.status || account.status === params.status)
      .sort((a, b) => {
        const bTime =
          typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt)
            ? b.updatedAt
            : 0;
        const aTime =
          typeof a.updatedAt === "number" && Number.isFinite(a.updatedAt)
            ? a.updatedAt
            : 0;
        return bTime - aTime || a.id.localeCompare(b.id);
      })
      .slice(offset);
    const selected =
      params.limit === undefined ? accounts : accounts.slice(0, params.limit);
    return selected.map((account) => ({
      ...account,
      scopes: [...account.scopes],
      purpose: [...account.purpose],
      capabilities: [...account.capabilities],
      profile: cloneConnectorJsonObject(account.profile),
      metadata: cloneConnectorJsonObject(account.metadata),
    }));
  }

  async getConnectorAccount(
    params: GetConnectorAccountParams,
  ): Promise<ConnectorAccountRecord | null> {
    let account: ConnectorAccountRecord | undefined;
    if (params.id) {
      account = this.connectorAccountsById.get(String(params.id));
    } else {
      if (!params.provider || !params.accountKey) {
        throw new ElizaError(
          "getConnectorAccount requires id or provider + accountKey",
          { code: "SQLITE_CONNECTOR_INVALID" },
        );
      }
      const key = connectorAccountKey({
        agentId: params.agentId ?? this.sqlite.agentId,
        provider: params.provider,
        accountKey: params.accountKey,
      });
      const accountId = this.connectorAccountIdsByKey.get(key);
      account = accountId
        ? this.connectorAccountsById.get(accountId)
        : undefined;
    }
    if (!account || account.deletedAt != null) return null;
    return {
      ...account,
      scopes: [...account.scopes],
      purpose: [...account.purpose],
      capabilities: [...account.capabilities],
      profile: cloneConnectorJsonObject(account.profile),
      metadata: cloneConnectorJsonObject(account.metadata),
    };
  }

  async upsertConnectorAccount(
    params: UpsertConnectorAccountParams,
  ): Promise<ConnectorAccountRecord> {
    const agentId = params.agentId ?? this.sqlite.agentId;
    const lookupKey = connectorAccountKey({
      agentId,
      provider: params.provider,
      accountKey: params.accountKey,
    });
    const requestedRole = params.role ?? "OWNER";
    const existingByExternalRole =
      params.externalId != null
        ? Array.from(this.connectorAccountsById.values()).find(
            (account) =>
              account.agentId === agentId &&
              account.provider === params.provider &&
              account.externalId === params.externalId &&
              account.role === requestedRole &&
              account.deletedAt == null,
          )
        : undefined;
    const existingByAccountKeyId = this.connectorAccountIdsByKey.get(lookupKey);
    const requestedId = params.id ? String(params.id) : undefined;
    const existingByRequestedId = requestedId
      ? this.connectorAccountsById.get(requestedId)
      : undefined;
    if (existingByRequestedId?.deletedAt != null) {
      throw new ElizaError(
        "Connector account id already belongs to a deleted account",
        { code: "SQLITE_CONNECTOR_INVALID" },
      );
    }

    let existingId: string | undefined;
    if (existingByRequestedId) {
      if (
        existingByAccountKeyId &&
        existingByAccountKeyId !== existingByRequestedId.id
      ) {
        throw new ElizaError(
          "Connector account id and account key resolve to different accounts",
          { code: "SQLITE_CONNECTOR_INVALID" },
        );
      }
      if (
        existingByExternalRole &&
        existingByExternalRole.id !== existingByRequestedId.id
      ) {
        throw new ElizaError(
          "Connector account id and external identity resolve to different accounts",
          { code: "SQLITE_CONNECTOR_INVALID" },
        );
      }
      existingId = existingByRequestedId.id;
    } else if (params.externalId != null) {
      if (
        existingByAccountKeyId &&
        existingByAccountKeyId !== existingByExternalRole?.id
      ) {
        throw new ElizaError(
          "Connector account key and external identity resolve to different accounts",
          { code: "SQLITE_CONNECTOR_INVALID" },
        );
      }
      existingId = existingByExternalRole?.id;
    } else {
      existingId = existingByAccountKeyId;
    }
    const existing = existingId
      ? this.connectorAccountsById.get(existingId)
      : undefined;
    const now = Date.now();
    const id = existing?.id ?? params.id ?? randomUuid();
    const profile = cloneConnectorJsonObject(
      params.profile !== undefined ? params.profile : existing?.profile,
    );
    const metadata = cloneConnectorJsonObject(
      params.metadata !== undefined ? params.metadata : existing?.metadata,
    );
    if (existing) {
      this.connectorAccountIdsByKey.delete(
        connectorAccountKey({
          agentId: existing.agentId,
          provider: existing.provider,
          accountKey: existing.accountKey,
        }),
      );
    }

    const connectedAt = connectorDateToMillis(params.connectedAt);
    const lastSyncAt = connectorDateToMillis(params.lastSyncAt);
    const deletedAt = connectorDateToMillis(params.deletedAt);
    const record: ConnectorAccountRecord = {
      id,
      agentId,
      provider: params.provider,
      accountKey: params.accountKey,
      externalId:
        params.externalId !== undefined
          ? params.externalId
          : existing?.externalId,
      displayName:
        params.displayName !== undefined
          ? params.displayName
          : existing?.displayName,
      username:
        params.username !== undefined ? params.username : existing?.username,
      email: params.email !== undefined ? params.email : existing?.email,
      ownerBindingId:
        params.ownerBindingId !== undefined
          ? params.ownerBindingId
          : existing?.ownerBindingId,
      ownerIdentityId:
        params.ownerIdentityId !== undefined
          ? params.ownerIdentityId
          : existing?.ownerIdentityId,
      role: params.role ?? existing?.role ?? "OWNER",
      purpose: params.purpose
        ? [...params.purpose]
        : [...(existing?.purpose ?? ["messaging"])],
      accessGate: params.accessGate ?? existing?.accessGate ?? "open",
      status: params.status ?? existing?.status ?? "connected",
      scopes: params.scopes
        ? [...params.scopes]
        : [...(existing?.scopes ?? [])],
      capabilities: params.capabilities
        ? [...params.capabilities]
        : [...(existing?.capabilities ?? [])],
      profile,
      metadata,
      connectedAt: connectedAt ?? existing?.connectedAt ?? now,
      lastSyncAt: lastSyncAt !== undefined ? lastSyncAt : existing?.lastSyncAt,
      deletedAt: deletedAt === undefined ? null : deletedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.connectorAccountsById.set(String(id), record);
    this.connectorAccountIdsByKey.set(lookupKey, String(id));
    return this.getConnectorAccount({ id }) as Promise<ConnectorAccountRecord>;
  }

  async deleteConnectorAccount(
    params: DeleteConnectorAccountParams,
  ): Promise<boolean> {
    const account = await this.getConnectorAccount(params);
    if (!account) return false;
    const now = Date.now();
    this.connectorAccountsById.set(String(account.id), {
      ...account,
      status: "disabled",
      deletedAt: now,
      updatedAt: now,
    });
    this.connectorAccountIdsByKey.delete(
      connectorAccountKey({
        agentId: account.agentId,
        provider: account.provider,
        accountKey: account.accountKey,
      }),
    );
    return true;
  }

  async setConnectorAccountCredentialRef(
    params: SetConnectorAccountCredentialRefParams,
  ): Promise<ConnectorAccountCredentialRefRecord> {
    const account = await this.getConnectorAccount({ id: params.accountId });
    if (!account) {
      throw new ElizaError(`Connector account not found: ${params.accountId}`, {
        code: "SQLITE_CONNECTOR_INVALID",
      });
    }
    const key = connectorCredentialKey(params);
    const existing = this.connectorCredentialRefs.get(key);
    const now = Date.now();
    const expiresAt = connectorDateToMillis(params.expiresAt);
    const lastVerifiedAt = connectorDateToMillis(params.lastVerifiedAt);
    const record: ConnectorAccountCredentialRefRecord = {
      id: existing?.id ?? randomUuid(),
      accountId: params.accountId,
      agentId: account.agentId,
      provider: account.provider,
      credentialType: params.credentialType,
      vaultRef: params.vaultRef,
      metadata:
        params.metadata !== undefined
          ? cloneConnectorJsonObject(params.metadata)
          : cloneConnectorJsonObject(existing?.metadata),
      expiresAt: expiresAt !== undefined ? expiresAt : existing?.expiresAt,
      lastVerifiedAt:
        lastVerifiedAt !== undefined
          ? lastVerifiedAt
          : existing?.lastVerifiedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.connectorCredentialRefs.set(key, record);
    return {
      ...record,
      metadata: cloneConnectorJsonObject(record.metadata),
    };
  }

  async getConnectorAccountCredentialRef(
    params: GetConnectorAccountCredentialRefParams,
  ): Promise<ConnectorAccountCredentialRefRecord | null> {
    const account = await this.getConnectorAccount({ id: params.accountId });
    if (!account) return null;
    const credential = this.connectorCredentialRefs.get(
      connectorCredentialKey(params),
    );
    return credential
      ? {
          ...credential,
          metadata: cloneConnectorJsonObject(credential.metadata),
        }
      : null;
  }

  async listConnectorAccountCredentialRefs(
    params: ListConnectorAccountCredentialRefsParams,
  ): Promise<ConnectorAccountCredentialRefRecord[]> {
    const account = await this.getConnectorAccount({ id: params.accountId });
    if (!account) return [];
    return Array.from(this.connectorCredentialRefs.values())
      .filter((credential) => credential.accountId === params.accountId)
      .sort((a, b) => {
        const bTime =
          typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt)
            ? b.updatedAt
            : 0;
        const aTime =
          typeof a.updatedAt === "number" && Number.isFinite(a.updatedAt)
            ? a.updatedAt
            : 0;
        return bTime - aTime || a.id.localeCompare(b.id);
      })
      .map((credential) => ({
        ...credential,
        metadata: cloneConnectorJsonObject(credential.metadata),
      }));
  }

  async deleteConnectorAccountCredentialRefs(
    params: DeleteConnectorAccountCredentialRefsParams,
  ): Promise<number> {
    let deleted = 0;
    for (const [key, credential] of this.connectorCredentialRefs) {
      if (credential.accountId === params.accountId) {
        this.connectorCredentialRefs.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async appendConnectorAccountAuditEvent(
    params: AppendConnectorAccountAuditEventParams,
  ): Promise<ConnectorAccountAuditEventRecord> {
    let agentId = params.agentId ?? this.sqlite.agentId;
    let provider = params.provider;
    if (params.accountId && (!params.agentId || !provider)) {
      const account = await this.getConnectorAccount({ id: params.accountId });
      if (!account) {
        throw new ElizaError(
          `Connector account not found: ${params.accountId}`,
          { code: "SQLITE_CONNECTOR_INVALID" },
        );
      }
      agentId = account.agentId;
      provider = account.provider;
    }
    if (!provider) {
      throw new ElizaError(
        "appendConnectorAccountAuditEvent requires provider or accountId",
        { code: "SQLITE_CONNECTOR_INVALID" },
      );
    }
    const record: ConnectorAccountAuditEventRecord = {
      id: randomUuid(),
      accountId: params.accountId ?? null,
      agentId,
      provider,
      actorId: params.actorId ?? null,
      action: params.action,
      outcome:
        params.outcome ?? ("success" satisfies ConnectorAccountAuditOutcome),
      metadata: redactConnectorAuditMetadata(params.metadata),
      createdAt: connectorDateToMillis(params.createdAt) ?? Date.now(),
    };
    this.connectorAuditEvents.set(String(record.id), record);
    return {
      ...record,
      metadata: redactConnectorJsonAudit(record.metadata, () => false),
    };
  }

  async createOAuthFlowState(
    params: CreateOAuthFlowStateParams,
  ): Promise<OAuthFlowRecord> {
    const stateHash = await sha256Hex(params.state);
    const agentId = params.agentId ?? this.sqlite.agentId;
    const key = oauthFlowKey({
      agentId,
      provider: params.provider,
      stateHash,
    });
    const existing = this.oauthFlowsByStateHash.get(key);
    const now = Date.now();
    const expiresAt =
      connectorDateToMillis(params.expiresAt) ??
      now + (params.ttlMs ?? 10 * 60_000);
    const record: OAuthFlowRecord = {
      stateHash,
      agentId,
      provider: params.provider,
      accountId: params.accountId ?? null,
      redirectUri: params.redirectUri ?? null,
      codeVerifierRef: params.codeVerifierRef ?? null,
      scopes: params.scopes ? [...params.scopes] : [],
      metadata: cloneConnectorJsonObject(params.metadata),
      createdAt: existing?.createdAt ?? now,
      expiresAt,
      consumedAt: null,
      consumedBy: null,
    };
    this.oauthFlowsByStateHash.set(key, record);
    return {
      ...record,
      scopes: [...record.scopes],
      metadata: cloneConnectorJsonObject(record.metadata),
    };
  }

  async consumeOAuthFlowState(
    params: ConsumeOAuthFlowStateParams,
  ): Promise<OAuthFlowRecord | null> {
    const existing = await this.findOAuthFlowState(params);
    const now = connectorDateToMillis(params.now) ?? Date.now();
    if (
      !existing ||
      existing.consumedAt != null ||
      existing.expiresAt <= now ||
      (params.agentId && existing.agentId !== params.agentId) ||
      (params.provider && existing.provider !== params.provider)
    ) {
      return null;
    }
    const record: OAuthFlowRecord = {
      ...existing,
      consumedAt: now,
      consumedBy: params.consumedBy ?? null,
    };
    this.oauthFlowsByStateHash.set(
      oauthFlowKey({
        agentId: record.agentId,
        provider: record.provider,
        stateHash: record.stateHash,
      }),
      record,
    );
    return {
      ...record,
      scopes: [...record.scopes],
      metadata: cloneConnectorJsonObject(record.metadata),
    };
  }

  private async findOAuthFlowState(
    params:
      | GetOAuthFlowStateParams
      | UpdateOAuthFlowStateParams
      | DeleteOAuthFlowStateParams,
  ): Promise<OAuthFlowRecord | null> {
    let stateHash = params.stateHash;
    if (!stateHash && params.state) {
      stateHash = await sha256Hex(params.state);
    }
    const agentId = params.agentId ?? this.sqlite.agentId;
    let existing = stateHash
      ? Array.from(this.oauthFlowsByStateHash.values()).find(
          (flow) =>
            flow.stateHash === stateHash &&
            flow.agentId === agentId &&
            (!params.provider || flow.provider === params.provider),
        )
      : undefined;
    if (!existing && params.flowId) {
      existing = Array.from(this.oauthFlowsByStateHash.values()).find(
        (flow) =>
          flow.metadata.flowId === params.flowId &&
          flow.agentId === agentId &&
          (!params.provider || flow.provider === params.provider),
      );
    }
    if (!existing) return null;
    const now =
      connectorDateToMillis((params as GetOAuthFlowStateParams).now) ??
      Date.now();
    const query = params as GetOAuthFlowStateParams;
    if (existing.agentId !== agentId) return null;
    if (params.provider && existing.provider !== params.provider) return null;
    if (!query.includeConsumed && existing.consumedAt != null) return null;
    if (!query.includeExpired && existing.expiresAt <= now) return null;
    return {
      ...existing,
      scopes: [...existing.scopes],
      metadata: cloneConnectorJsonObject(existing.metadata),
    };
  }

  async getOAuthFlowState(
    params: GetOAuthFlowStateParams,
  ): Promise<OAuthFlowRecord | null> {
    return this.findOAuthFlowState(params);
  }

  async updateOAuthFlowState(
    params: UpdateOAuthFlowStateParams,
  ): Promise<OAuthFlowRecord | null> {
    const existing = await this.findOAuthFlowState({
      ...params,
      includeConsumed: true,
      includeExpired: true,
    });
    if (!existing) return null;
    const expiresAt = connectorDateToMillis(params.expiresAt);
    const consumedAt = connectorDateToMillis(params.consumedAt);
    const record: OAuthFlowRecord = {
      ...existing,
      accountId:
        params.accountId !== undefined ? params.accountId : existing.accountId,
      redirectUri:
        params.redirectUri !== undefined
          ? params.redirectUri
          : existing.redirectUri,
      codeVerifierRef:
        params.codeVerifierRef !== undefined
          ? params.codeVerifierRef
          : existing.codeVerifierRef,
      scopes: params.scopes ? [...params.scopes] : [...existing.scopes],
      metadata: {
        ...cloneConnectorJsonObject(existing.metadata),
        ...(params.metadata ? cloneConnectorJsonObject(params.metadata) : {}),
      },
      expiresAt: expiresAt ?? existing.expiresAt,
      consumedAt:
        params.consumedAt !== undefined ? consumedAt : existing.consumedAt,
      consumedBy:
        params.consumedBy !== undefined
          ? params.consumedBy
          : existing.consumedBy,
    };
    this.oauthFlowsByStateHash.set(
      oauthFlowKey({
        agentId: record.agentId,
        provider: record.provider,
        stateHash: record.stateHash,
      }),
      record,
    );
    return {
      ...record,
      scopes: [...record.scopes],
      metadata: cloneConnectorJsonObject(record.metadata),
    };
  }

  async deleteOAuthFlowState(
    params: DeleteOAuthFlowStateParams,
  ): Promise<boolean> {
    const existing = await this.findOAuthFlowState({
      ...params,
      includeConsumed: true,
      includeExpired: true,
    });
    if (!existing) return false;
    return this.oauthFlowsByStateHash.delete(
      oauthFlowKey({
        agentId: existing.agentId,
        provider: existing.provider,
        stateHash: existing.stateHash,
      }),
    );
  }
}
