// spec/core/storage.md, "Story: Preserve storage compatibility without hiding unsupported operations"
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { filterMemoryReadByAccessContext } from "../../src/access-control/filter.vibe";
import {
  DatabaseAdapter,
  validateQueryEntitiesPaginationOrThrow,
  validateTaskQueryPaginationOrThrow,
} from "../../src/database.vibe";
import { encodeCacheCasValueOrThrow } from "../../src/database/cache-cas.vibe";
import { cloneConnectorJsonObjectOrThrow, redactConnectorJsonAuditOrThrow } from "../../src/database/connector-json.vibe";
import {
  advanceWorldMetadataRevisionOrThrow,
  appendWorldMetadataRoleAuditOrThrow,
  getWorldMetadataRevision,
  initializeWorldMetadataRevisionOrThrow,
  requireFreshWorldMetadataRevisionOrThrow,
  worldMetadataValueEquals,
} from "../../src/database/world-metadata-cas.vibe";
import { ElizaError } from "../../src/errors.vibe";
import { rankMessageSearch, rerankMemories, withinCreatedAtWindow } from "../../src/retrieval.vibe";
import {
  authorizeMessageContentReadOrThrow,
  canonicalAttachmentText,
  hashAttachmentIdForLocator,
  MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES,
  MESSAGE_CONTENT_READ_MAX_SEGMENTS,
  MESSAGE_CONTENT_SEGMENT_TABLE,
  readMessageContentProjectionOrThrow,
  resolveMessageContentSourceDescriptorOrThrow,
} from "../../src/runtime/message-content-segments.vibe";
import { type AccessContext } from "../../src/types/access-context.vibe";
import { type Agent } from "../../src/types/agent.vibe";
import {
  type AppendConnectorAccountAuditEventParams,
  type ConnectorAccountAuditEventRecord,
  type ConnectorAccountRecord,
  type ConsumeOAuthFlowStateParams,
  type CreateOAuthFlowStateParams,
  type DeleteConnectorAccountParams,
  type DeleteOAuthFlowStateParams,
  type EntitiesForRoomsResult,
  type GetConnectorAccountParams,
  type GetOAuthFlowStateParams,
  type IDatabaseAdapter,
  type ListConnectorAccountsParams,
  type Log,
  type LogBody,
  type MemoryEmbeddingUpdate,
  type MessageContentPublicationParams,
  type MessageContentPublicationResult,
  type MessageContentRangeReadParams,
  type MessageContentRangeReadResult,
  type MessageSearchHit,
  type OAuthFlowRecord,
  type ParticipantsForRoomsResult,
  type ParticipantUserState,
  type PatchOp,
  type PairingAllowlistsResult,
  type PairingRequestsResult,
  ROLE_WRITE_AUDIT_LOG_TYPE,
  type UpdateOAuthFlowStateParams,
  type UpsertConnectorAccountParams,
  type WorldMetadataCompareAndSwapParams,
  type WorldMetadataMutationResult,
} from "../../src/types/database.vibe";
import { type Component, type Entity, type Participant, type Relationship, type Room, type World } from "../../src/types/environment.vibe";
import { type Memory, type MemoryMetadata } from "../../src/types/memory.vibe";
import {
  normalizePairingPageOptionsOrThrow,
  type PairingAllowlistEntry,
  type PairingAllowlistQuery,
  type PairingPageInfo,
  type PairingQueryOptions,
  type PairingRequest,
  type PairingRequestQuery,
} from "../../src/types/pairing.vibe";
import { type JsonValue, type Metadata, type UUID } from "../../src/types/primitives.vibe";
import { type Task, type TaskMetadata, type TaskMetadataPatch } from "../../src/types/task.vibe";

const TABLES = [
  "agents",
  "entities",
  "components",
  "worlds",
  "rooms",
  "participants",
  "relationships",
  "memories",
  "caches",
  "logs",
  "tasks",
  "pairing_requests",
  "pairing_allowlist",
  "connector_accounts",
  "connector_audit",
  "oauth_flows",
  "owner_bindings",
  "meta",
] as const;

type Table = (typeof TABLES)[number];

interface Row {
  id: string;
  createdAt: number;
  revision: number;
  scope: string | null;
  body: string;
}

interface StoredParticipant {
  id: UUID;
  entityId: UUID;
  roomId: UUID;
  roomState?: ParticipantUserState;
}

interface StoredLog {
  id: UUID;
  type: string;
  entityId: UUID;
  roomId?: UUID;
  body: LogBody;
}

type StoredPairing<T> = Omit<T, "createdAt" | "lastSeenAt"> & { createdAt: number; lastSeenAt?: number };

interface OwnerBinding {
  id: string;
  identityId: string;
  connector: string;
  externalId: string;
  displayHandle: string;
  instanceId: string;
  verifiedAt: number;
}

export type Fault = { reject: unknown } | { resolve: unknown } | { gate: Promise<void> };

export class AdapterFixtureGap extends Error {
  readonly member: string;

  constructor(member: string) {
    super(`sqlite adapter: ${member} is not implemented`);
    this.name = "AdapterFixtureGap";
    this.member = member;
  }
}

const COLUMNS = "id, created_at, revision, scope, body";

const AUDIT_SECRET_KEY =
  /(access|refresh|id)?_?token|secret|password|credential|authorization|cookie|code[_-]?verifier|codeVerifier|client[_-]?secret|api_?key|private_?key|oauth_?code|state/i;

function missing(member: string): (...args: unknown[]) => Promise<never> {
  return () => Promise.reject(new AdapterFixtureGap(member));
}

function toRow(record: Record<string, SQLOutputValue>): Row {
  const { id, created_at, revision, scope, body } = record;
  if (typeof id !== "string" || typeof created_at !== "number" || typeof revision !== "number" || typeof body !== "string") {
    throw new TypeError(`sqlite adapter: malformed row ${String(id)}`);
  }
  return { id, createdAt: created_at, revision, scope: typeof scope === "string" ? scope : null, body };
}

function parse<T>(row: Row): T {
  return JSON.parse(row.body) as T;
}

function list(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contains(value: unknown, filter: unknown): boolean {
  if (Array.isArray(filter)) {
    return Array.isArray(value) && filter.every((wanted) => value.some((item) => contains(item, wanted)));
  }
  if (isRecord(filter)) {
    return isRecord(value) && Object.entries(filter).every(([key, wanted]) => key in value && contains(value[key], wanted));
  }
  return value === filter;
}

function matchesMetadata(metadata: unknown, wanted: Record<string, unknown> | undefined): boolean {
  if (!wanted) return true;
  const stored = isRecord(metadata) ? metadata : {};
  return Object.entries(wanted).every(([key, value]) => stored[key] === value);
}

function applyPatch(data: Record<string, unknown>, op: PatchOp): void {
  const keys = op.path.split(".");
  const last = keys.pop() ?? "";
  let parent = data;
  for (const key of keys) {
    const next = parent[key];
    const child = isRecord(next) ? next : {};
    parent[key] = child;
    parent = child;
  }
  const current = parent[last];
  if (op.op === "set") parent[last] = op.value;
  else if (op.op === "remove") delete parent[last];
  else if (op.op === "push") parent[last] = [...(Array.isArray(current) ? (current as unknown[]) : []), op.value];
  else if (typeof op.value === "number" && (current === undefined || typeof current === "number")) {
    parent[last] = (current ?? 0) + op.value;
  } else {
    throw new ElizaError(`Patch increment at ${op.path} requires numbers`, { code: "COMPONENT_PATCH_INVALID" });
  }
}

function cosine(left: SQLOutputValue, right: SQLOutputValue): number | null {
  if (typeof left !== "string" || typeof right !== "string") return null;
  const a = JSON.parse(left) as number[];
  const b = JSON.parse(right) as number[];
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  a.forEach((value, index) => {
    const other = b[index] ?? 0;
    dot += value * other;
    normA += value * value;
    normB += other * other;
  });
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function millis(value: number | Date | null | undefined): number | null | undefined {
  return value instanceof Date ? value.getTime() : value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutEmbedding(memory: Memory): Memory {
  const { embedding: _embedding, ...rest } = memory;
  return rest;
}

function pairingPage<T extends { id: UUID; createdAt: Date }>(
  rows: T[],
  query: PairingQueryOptions,
): { rows: T[]; pageInfo?: PairingPageInfo } {
  const paged = query.limit !== undefined || query.offset !== undefined;
  if (query.order === "newest") rows.reverse();
  if (!paged) return { rows };
  const { limit, offset } = normalizePairingPageOptionsOrThrow(query);
  const page = rows.slice(offset, offset + limit + 1);
  const hasMore = page.length > limit;
  return { rows: page.slice(0, limit), pageInfo: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null } };
}

const WAKE_KEYS = ["wakeAt", "wakeRevision"] as const;

function authoredWake(): ElizaError {
  return new ElizaError("Task wake keys require atomic wake operation", { code: "TASK_WAKE_INVALID" });
}

function keepWake(stored: TaskMetadata | undefined, replacement: TaskMetadata): TaskMetadata {
  const { wakeAt: _wakeAt, wakeRevision: _wakeRevision, ...rest } = replacement;
  return {
    ...rest,
    ...(stored?.wakeAt === undefined ? {} : { wakeAt: stored.wakeAt }),
    ...(stored?.wakeRevision === undefined ? {} : { wakeRevision: stored.wakeRevision }),
  };
}

function withKeptWake(existing: Task, update: Partial<Task>): Task {
  return { ...existing, ...update, ...(update.metadata ? { metadata: keepWake(existing.metadata, update.metadata) } : {}) };
}

export class SqliteStore {
  readonly closeLog: string[] = [];
  readonly path: string;
  readonly scope = new AsyncLocalStorage<SqliteAdapter>();
  transactionTail: Promise<unknown> = Promise.resolve();
  openTransactions = 0;

  constructor(path: string) {
    this.path = path;
    const connection = new DatabaseSync(path);
    connection.exec("PRAGMA journal_mode = WAL");
    for (const table of TABLES) {
      connection.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, scope TEXT, natural_key TEXT UNIQUE, body TEXT NOT NULL)`,
      );
    }
    connection.exec("CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope, created_at)");
    connection.close();
  }

  open(): DatabaseSync {
    const connection = new DatabaseSync(this.path);
    connection.function("cosine_similarity", { deterministic: true }, cosine);
    return connection;
  }

  bindConnectorOwner(binding: OwnerBinding): void {
    const connection = new DatabaseSync(this.path);
    connection
      .prepare(`INSERT INTO owner_bindings (id, created_at, natural_key, body) VALUES (?, ?, ?, ?)`)
      .run(binding.id, binding.verifiedAt, list([binding.connector, binding.externalId, binding.instanceId]), JSON.stringify(binding));
    connection.close();
  }
}

export class SqliteAdapter extends DatabaseAdapter<SqliteStore> {
  readonly messageContentSegmentCapability = 1 as const;
  readonly documentListQueryCapability = 4 as const;
  readonly supportsAtomicTaskWake = true;
  readonly migrations: Array<{ member: "runMigrations" | "runPluginMigrations"; args: unknown[] }> = [];

  readonly queryDocuments = missing("queryDocuments");
  readonly getDocument = missing("getDocument");
  readonly queryDocumentFragments = missing("queryDocumentFragments");
  readonly compareAndSwapDocument = missing("compareAndSwapDocument");
  readonly updateDocumentDirectGrants = missing("updateDocumentDirectGrants");
  readonly replaceDocumentRevision = missing("replaceDocumentRevision");
  readonly deleteDocumentWithSnapshot = missing("deleteDocumentWithSnapshot");
  readonly searchEntitiesByName = missing("searchEntitiesByName");
  readonly deleteEntities = missing("deleteEntities");
  readonly getLogInventory = missing("getLogInventory");
  readonly getLogsByIds = missing("getLogsByIds");
  readonly updateLogs = missing("updateLogs");
  readonly deleteLogs = missing("deleteLogs");
  readonly deleteAllMemories = missing("deleteAllMemories");
  readonly deleteWorlds = missing("deleteWorlds");
  readonly deleteRoomsByWorldIds = missing("deleteRoomsByWorldIds");
  readonly updateParticipants = missing("updateParticipants");
  readonly deleteRooms = missing("deleteRooms");
  readonly deleteRelationships = missing("deleteRelationships");
  readonly cleanupAgents = missing("cleanupAgents");
  readonly getMemoriesByWorldId = missing("getMemoriesByWorldId");

  private readonly store: SqliteStore;
  private readonly label: string;
  private readonly connection: DatabaseSync;
  private readonly faults = new Map<string, { fault: Fault; remaining: number }>();
  private ready = false;
  private owner: UUID | undefined;
  private savepoints = 0;

  constructor(store: SqliteStore, label: string) {
    super();
    this.store = store;
    this.label = label;
    this.db = store;
    this.connection = store.open();
  }

  fault(member: string, fault: Fault, times = 1): void {
    if (times > 0) this.faults.set(member, { fault, remaining: times });
  }

  private async run<T>(member: string, body: () => T | Promise<T>): Promise<T> {
    const scope = this.store.scope.getStore();
    if (scope && scope !== this) throw new Error(`sqlite adapter ${this.label}: ${member} called inside the transaction of adapter ${scope.label}`);
    while (!scope && member !== "transaction" && this.store.openTransactions > 0) await this.store.transactionTail;
    if (!this.connection.isOpen) throw new Error(`sqlite adapter ${this.label}: ${member} called after close`);
    const injected = this.faults.get(member);
    if (injected) {
      injected.remaining -= 1;
      if (injected.remaining <= 0) this.faults.delete(member);
      const { fault } = injected;
      if ("reject" in fault) throw fault.reject;
      if ("resolve" in fault) return fault.resolve as T;
      await fault.gate;
    }
    return await body();
  }

  private atomic<T>(body: () => T): T {
    const name = `fixture_${++this.savepoints}`;
    this.connection.exec(`SAVEPOINT ${name}`);
    try {
      const result = body();
      this.connection.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.connection.exec(`ROLLBACK TO ${name}`);
      this.connection.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  private rows(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.connection.prepare(sql).all(...params).map(toRow);
  }

  private select<T>(table: Table, where = "1", params: SQLInputValue[] = [], order = "created_at, rowid"): T[] {
    return this.rows(`SELECT ${COLUMNS} FROM ${table} WHERE ${where} ORDER BY ${order}`, ...params).map((row) => parse<T>(row));
  }

  private byIds<T>(table: Table, ids: readonly string[], where = "1", params: SQLInputValue[] = []): T[] {
    return this.rows(
      `SELECT t.id, t.created_at, t.revision, t.scope, t.body FROM ${table} t JOIN json_each(?) j ON j.value = t.id WHERE ${where} ORDER BY j.key`,
      list(ids),
      ...params,
    ).map((row) => parse<T>(row));
  }

  private row(table: Table, id: string): Row | undefined {
    const found = this.connection.prepare(`SELECT ${COLUMNS} FROM ${table} WHERE id = ?`).get(id);
    return found ? toRow(found) : undefined;
  }

  private insert(table: Table, id: string, createdAt: number, body: unknown, scope: string | null = null, naturalKey: string | null = null): void {
    this.connection
      .prepare(`INSERT INTO ${table} (id, created_at, scope, natural_key, body) VALUES (?, ?, ?, ?, ?)`)
      .run(id, createdAt, scope, naturalKey, JSON.stringify(body));
  }

  private put(table: Table, id: string, createdAt: number, body: unknown, scope: string | null = null, naturalKey: string | null = null): void {
    this.connection
      .prepare(
        `INSERT INTO ${table} (id, created_at, scope, natural_key, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, scope = excluded.scope, natural_key = excluded.natural_key, revision = revision + 1`,
      )
      .run(id, createdAt, scope, naturalKey, JSON.stringify(body));
  }

  private replace(table: Table, id: string, body: unknown, revision?: number): boolean {
    const result = revision === undefined
      ? this.connection.prepare(`UPDATE ${table} SET body = ?, revision = revision + 1 WHERE id = ?`).run(JSON.stringify(body), id)
      : this.connection.prepare(`UPDATE ${table} SET body = ?, revision = revision + 1 WHERE id = ? AND revision = ?`).run(JSON.stringify(body), id, revision);
    return Number(result.changes) === 1;
  }

  private remove(table: Table, ids: readonly string[]): number {
    return Number(this.connection.prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).run(list(ids)).changes);
  }

  private agentId(): UUID {
    if (this.owner) return this.owner;
    const agents = this.rows(`SELECT ${COLUMNS} FROM agents`);
    const [only] = agents;
    if (only && agents.length === 1) return only.id;
    throw new Error(`sqlite adapter ${this.label}: no agent was stored through this adapter`);
  }

  private ownedBy(): [string, SQLInputValue[]] {
    return this.owner
      ? ["(json_extract(body, '$.agentId') IS NULL OR json_extract(body, '$.agentId') = ?)", [this.owner]]
      : ["1", []];
  }

  private claim(agents: Partial<Agent>[]): void {
    this.owner ??= agents[0]?.id;
  }

  initialize(_config?: Record<string, string | number | boolean | null>): Promise<void> {
    return this.run("initialize", () => {
      this.ready = true;
    });
  }

  isReady(): Promise<boolean> {
    return this.run("isReady", () => this.ready);
  }

  close(): Promise<void> {
    return this.run("close", () => {
      this.connection.close();
      this.ready = false;
      this.store.closeLog.push(this.label);
    });
  }

  getConnection(): Promise<SqliteStore> {
    return this.run("getConnection", () => this.store);
  }

  runMigrations(migrationsPaths?: string[]): Promise<void> {
    return this.run("runMigrations", () => {
      this.migrations.push({ member: "runMigrations", args: [migrationsPaths] });
    });
  }

  runPluginMigrations(
    plugins: Array<{ name: string; schema?: Record<string, JsonValue> }>,
    options?: { verbose?: boolean; force?: boolean; dryRun?: boolean },
  ): Promise<void> {
    return this.run("runPluginMigrations", () => {
      this.migrations.push({ member: "runPluginMigrations", args: [plugins, options] });
    });
  }

  transaction<T>(callback: (tx: IDatabaseAdapter<SqliteStore>) => Promise<T>, _options?: { entityContext?: UUID }): Promise<T> {
    return this.run("transaction", () => {
      if (this.store.scope.getStore() === this) return this.nested(callback);
      const store = this.store;
      store.openTransactions += 1;
      const current = store.transactionTail.then(() => this.outer(callback)).finally(() => {
        store.openTransactions -= 1;
      });
      store.transactionTail = current.catch(() => undefined);
      return current;
    });
  }

  private async outer<T>(callback: (tx: IDatabaseAdapter<SqliteStore>) => Promise<T>): Promise<T> {
    if (!this.connection.isOpen) throw new Error(`sqlite adapter ${this.label}: transaction called after close`);
    this.connection.exec("BEGIN");
    try {
      const result = await this.store.scope.run(this, () => callback(this));
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  private async nested<T>(callback: (tx: IDatabaseAdapter<SqliteStore>) => Promise<T>): Promise<T> {
    const name = `transaction_${++this.savepoints}`;
    this.connection.exec(`SAVEPOINT ${name}`);
    try {
      const result = await callback(this);
      this.connection.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.connection.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }

  getAgents(): Promise<Partial<Agent>[]> {
    return this.run("getAgents", () => this.select<Partial<Agent>>("agents"));
  }

  getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
    return this.run("getAgentsByIds", () => this.byIds<Agent>("agents", agentIds));
  }

  createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
    return this.run("createAgents", () =>
      this.atomic(() => {
        const ids = agents.map((agent) => {
          const id = agent.id ?? randomUUID();
          this.insert("agents", id, Number(agent.createdAt ?? Date.now()), { ...agent, id });
          return id;
        });
        this.claim(agents);
        return ids;
      }));
  }

  upsertAgents(agents: Partial<Agent>[]): Promise<void> {
    return this.run("upsertAgents", () =>
      this.atomic(() => {
        for (const agent of agents) {
          const id = agent.id ?? randomUUID();
          const existing = this.row("agents", id);
          const merged = { ...(existing ? parse<Partial<Agent>>(existing) : {}), ...agent, id };
          this.put("agents", id, existing?.createdAt ?? Number(agent.createdAt ?? Date.now()), merged);
        }
        this.claim(agents);
      }));
  }

  updateAgents(updates: Array<{ agentId: UUID; agent: Partial<Agent> }>): Promise<boolean> {
    return this.run("updateAgents", () =>
      this.atomic(() =>
        updates.reduce((updated, { agentId, agent }) => {
          const existing = this.row("agents", agentId);
          return existing ? this.replace("agents", agentId, { ...parse<Agent>(existing), ...agent }) || updated : updated;
        }, false)
      ));
  }

  deleteAgents(agentIds: UUID[]): Promise<boolean> {
    return this.run("deleteAgents", () => this.remove("agents", agentIds) > 0);
  }

  countAgents(): Promise<number> {
    return this.run("countAgents", () => Number(this.connection.prepare("SELECT count(*) AS n FROM agents").get()?.n ?? 0));
  }

  private componentsFor(entityIds: readonly string[], worldId?: UUID, sourceEntityId?: UUID): Component[] {
    return this.select<Component>(
      "components",
      "json_extract(body, '$.entityId') IN (SELECT value FROM json_each(?)) AND (? IS NULL OR json_extract(body, '$.worldId') = ?) AND (? IS NULL OR json_extract(body, '$.sourceEntityId') = ?)",
      [list(entityIds), worldId ?? null, worldId ?? null, sourceEntityId ?? null, sourceEntityId ?? null],
    );
  }

  private withComponents(entities: Entity[]): Entity[] {
    const components = this.componentsFor(entities.flatMap((entity) => (entity.id ? [entity.id] : [])));
    return entities.map((entity) => ({ ...entity, components: components.filter((component) => component.entityId === entity.id) }));
  }

  private participants(where: string, params: SQLInputValue[]): StoredParticipant[] {
    return this.select<StoredParticipant>("participants", where, params);
  }

  getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
    return this.run("getEntitiesByIds", () => this.withComponents(this.byIds<Entity>("entities", entityIds)));
  }

  getEntitiesForRooms(roomIds: UUID[], includeComponents?: boolean): Promise<EntitiesForRoomsResult> {
    return this.run("getEntitiesForRooms", () =>
      roomIds.map((roomId) => {
        const entityIds = [...new Set(this.participants("json_extract(body, '$.roomId') = ?", [roomId]).map((p) => p.entityId))];
        const entities = this.byIds<Entity>("entities", entityIds);
        return { roomId, entities: includeComponents ? this.withComponents(entities) : entities };
      }));
  }

  createEntities(entities: Entity[]): Promise<UUID[]> {
    return this.run("createEntities", () =>
      this.atomic(() =>
        entities.map(({ components: _components, ...entity }) => {
          const id = entity.id ?? randomUUID();
          this.insert("entities", id, Date.now(), { ...entity, id });
          return id;
        })
      ));
  }

  upsertEntities(entities: Entity[]): Promise<void> {
    return this.run("upsertEntities", () =>
      this.atomic(() => {
        for (const { components: _components, ...entity } of entities) {
          if (!entity.id) continue;
          const existing = this.row("entities", entity.id);
          this.put("entities", entity.id, existing?.createdAt ?? Date.now(), { ...(existing ? parse<Entity>(existing) : {}), ...entity });
        }
      }));
  }

  updateEntities(entities: Entity[]): Promise<void> {
    return this.run("updateEntities", () =>
      this.atomic(() => {
        for (const { components: _components, ...entity } of entities) {
          const existing = entity.id ? this.row("entities", entity.id) : undefined;
          if (existing) this.replace("entities", existing.id, { ...parse<Entity>(existing), ...entity });
        }
      }));
  }

  getEntitiesByNames(params: { names: string[]; agentId: UUID }): Promise<Entity[]> {
    return this.run("getEntitiesByNames", () =>
      this.select<Entity>(
        "entities",
        "json_extract(body, '$.agentId') = ? AND EXISTS (SELECT 1 FROM json_each(body, '$.names') n WHERE n.value IN (SELECT value FROM json_each(?)))",
        [params.agentId, list(params.names)],
      ));
  }

  queryEntities(params: {
    componentType?: string;
    componentDataFilter?: Record<string, unknown>;
    agentId?: UUID;
    entityIds?: UUID[];
    worldId?: UUID;
    limit?: number;
    offset?: number;
    includeAllComponents?: boolean;
    entityContext?: UUID;
  }): Promise<Entity[]> {
    return this.run("queryEntities", () => {
      validateQueryEntitiesPaginationOrThrow(params);
      const componentQuery = params.componentType !== undefined || params.componentDataFilter !== undefined || params.worldId !== undefined;
      const matched = new Map<string, Component[]>();
      if (componentQuery) {
        const components = this.select<Component>(
          "components",
          "(? IS NULL OR json_extract(body, '$.agentId') = ?) AND (? IS NULL OR json_extract(body, '$.type') = ?) AND (? IS NULL OR json_extract(body, '$.worldId') = ?)",
          [params.agentId ?? null, params.agentId ?? null, params.componentType ?? null, params.componentType ?? null, params.worldId ?? null, params.worldId ?? null],
        );
        for (const component of components) {
          if (params.entityIds?.length && !params.entityIds.includes(component.entityId)) continue;
          if (params.componentDataFilter && !contains(component.data ?? {}, params.componentDataFilter)) continue;
          matched.set(component.entityId, [...(matched.get(component.entityId) ?? []), component]);
        }
      }
      let entityIds: string[];
      if (componentQuery) entityIds = params.entityIds?.length ? params.entityIds.filter((id) => matched.has(id)) : [...matched.keys()];
      else if (params.entityIds?.length) entityIds = params.entityIds;
      else if (params.limit !== undefined) entityIds = this.select<Entity>("entities").flatMap((entity) => (entity.id ? [entity.id] : []));
      else return [];
      const candidates = this.byIds<Entity>("entities", entityIds).filter((entity) => !params.agentId || entity.agentId === params.agentId);
      const offset = params.offset ?? 0;
      return candidates.slice(offset, offset + (params.limit ?? candidates.length)).map((entity) => {
        if (!params.includeAllComponents && !componentQuery) return entity;
        const components = params.includeAllComponents
          ? this.componentsFor(entity.id ? [entity.id] : []).filter((component) => !params.agentId || component.agentId === params.agentId)
          : (matched.get(entity.id ?? "") ?? []);
        return { ...entity, components };
      });
    });
  }

  private componentKey(component: { entityId: UUID; type: string; worldId?: UUID; sourceEntityId?: UUID }): string {
    return list([component.entityId, component.type, component.worldId ?? null, component.sourceEntityId ?? null]);
  }

  getComponentsByNaturalKeys(keys: Array<{ entityId: UUID; type: string; worldId?: UUID; sourceEntityId?: UUID }>): Promise<(Component | null)[]> {
    return this.run("getComponentsByNaturalKeys", () =>
      keys.map((key) =>
        this.componentsFor([key.entityId], key.worldId, key.sourceEntityId).find((component) => component.type === key.type) ?? null
      ));
  }

  getComponentsForEntities(entityIds: UUID[], worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return this.run("getComponentsForEntities", () => this.componentsFor(entityIds, worldId, sourceEntityId));
  }

  createComponents(components: Component[]): Promise<UUID[]> {
    return this.run("createComponents", () =>
      this.atomic(() =>
        components.map((component) => {
          this.insert("components", component.id, component.createdAt ?? Date.now(), component, null, this.componentKey(component));
          return component.id;
        })
      ));
  }

  getComponentsByIds(componentIds: UUID[]): Promise<Component[]> {
    return this.run("getComponentsByIds", () => this.byIds<Component>("components", componentIds));
  }

  updateComponents(components: Component[]): Promise<void> {
    return this.run("updateComponents", () =>
      this.atomic(() => {
        for (const component of components) {
          const existing = this.row("components", component.id);
          if (!existing) continue;
          const merged = { ...parse<Component>(existing), ...component };
          this.put("components", component.id, existing.createdAt, merged, null, this.componentKey(merged));
        }
      }));
  }

  deleteComponents(componentIds: UUID[]): Promise<void> {
    return this.run("deleteComponents", () => {
      this.remove("components", componentIds);
    });
  }

  upsertComponents(components: Component[], _options?: { entityContext?: UUID }): Promise<void> {
    return this.run("upsertComponents", () =>
      this.atomic(() => {
        const latest = new Map(components.map((component) => [this.componentKey(component), component]));
        for (const [naturalKey, component] of latest) {
          const existing = this.rows(`SELECT ${COLUMNS} FROM components WHERE natural_key = ?`, naturalKey)[0];
          if (existing) this.replace("components", existing.id, { ...parse<Component>(existing), ...component, id: existing.id });
          else this.insert("components", component.id, component.createdAt ?? Date.now(), component, null, naturalKey);
        }
      }));
  }

  patchComponents(updates: Array<{ componentId: UUID; ops: PatchOp[] }>, _options?: { entityContext?: UUID }): Promise<void> {
    return this.run("patchComponents", () =>
      this.atomic(() => {
        for (const { componentId, ops } of updates) {
          const existing = this.row("components", componentId);
          if (!existing) continue;
          const component = parse<Component>(existing);
          const data = structuredClone(component.data ?? {}) as Record<string, unknown>;
          for (const op of ops) applyPatch(data, op);
          this.replace("components", componentId, { ...component, data });
        }
      }));
  }

  getAllWorlds(): Promise<World[]> {
    return this.run("getAllWorlds", () => {
      const [where, params] = this.ownedBy();
      return this.select<World>("worlds", where, params);
    });
  }

  getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
    return this.run("getWorldsByIds", () => {
      const [where, params] = this.ownedBy();
      return this.byIds<World>("worlds", worldIds, where, params);
    });
  }

  createWorlds(worlds: World[]): Promise<UUID[]> {
    return this.run("createWorlds", () =>
      this.atomic(() =>
        worlds.map((world) => {
          this.insert("worlds", world.id, Date.now(), { ...world, metadata: initializeWorldMetadataRevisionOrThrow(world.metadata as Metadata | undefined) });
          return world.id;
        })
      ));
  }

  private writeWorld(world: World, existing: Row): void {
    const storedRevision = requireFreshWorldMetadataRevisionOrThrow(
      parse<World>(existing).metadata as Metadata | undefined,
      world.metadata as Metadata | undefined,
      world.id,
    );
    const metadata = advanceWorldMetadataRevisionOrThrow(world.metadata as Metadata | undefined, storedRevision);
    this.replace("worlds", world.id, { ...parse<World>(existing), ...world, metadata }, existing.revision);
    world.metadata = structuredClone(metadata);
  }

  upsertWorlds(worlds: World[]): Promise<void> {
    return this.run("upsertWorlds", () =>
      this.atomic(() => {
        for (const world of worlds) {
          const existing = this.row("worlds", world.id);
          if (existing) this.writeWorld(world, existing);
          else this.insert("worlds", world.id, Date.now(), { ...world, metadata: initializeWorldMetadataRevisionOrThrow(world.metadata as Metadata | undefined) });
        }
      }));
  }

  updateWorlds(worlds: World[]): Promise<void> {
    return this.run("updateWorlds", () =>
      this.atomic(() => {
        for (const world of worlds) {
          const existing = this.row("worlds", world.id);
          if (existing) this.writeWorld(world, existing);
        }
      }));
  }

  override compareAndSwapWorldMetadata(params: WorldMetadataCompareAndSwapParams): Promise<WorldMetadataMutationResult> {
    return this.run("compareAndSwapWorldMetadata", () =>
      this.atomic((): WorldMetadataMutationResult => {
        const stored = this.row("worlds", params.worldId);
        if (!stored) return { status: "not_found" };
        const world = parse<World>(stored);
        const storedRevision = getWorldMetadataRevision(world.metadata as Metadata | undefined);
        if (storedRevision === null || !worldMetadataValueEquals(world.metadata ?? {}, params.expectedMetadata)) return { status: "conflict" };
        const audit = params.audit;
        const replacement = audit
          ? appendWorldMetadataRoleAuditOrThrow(params.replacementMetadata, { ...audit })
          : params.replacementMetadata;
        const metadata = advanceWorldMetadataRevisionOrThrow(replacement, storedRevision);
        if (!this.replace("worlds", params.worldId, { ...world, metadata }, stored.revision)) return { status: "conflict" };
        if (audit) {
          const log: StoredLog = {
            id: randomUUID(),
            type: ROLE_WRITE_AUDIT_LOG_TYPE,
            entityId: audit.actorEntityId,
            roomId: audit.roomId,
            body: {
              source: "role-write-cas",
              metadata: {
                worldId: params.worldId,
                actorEntityId: audit.actorEntityId,
                targetEntityId: audit.targetEntityId,
                previousRole: audit.previousRole,
                newRole: audit.newRole,
                grantSource: audit.source,
                outcome: "committed",
              },
            },
          };
          this.insert("logs", log.id, Date.now(), log);
        }
        return { status: "updated" };
      }));
  }

  getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
    return this.run("getRoomsByIds", () => {
      const [where, params] = this.ownedBy();
      return this.byIds<Room>("rooms", roomIds, where, params);
    });
  }

  getRoomsByWorlds(worldIds: UUID[], limit?: number, offset?: number): Promise<Room[]> {
    return this.run("getRoomsByWorlds", () => {
      const [where, params] = this.ownedBy();
      const rooms = this.select<Room>("rooms", `json_extract(body, '$.worldId') IN (SELECT value FROM json_each(?)) AND ${where}`, [list(worldIds), ...params]);
      const start = offset ?? 0;
      return rooms.slice(start, limit === undefined ? undefined : start + limit);
    });
  }

  getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    return this.run("getRoomsForParticipants", () => {
      const roomIds = [...new Set(this.participants("json_extract(body, '$.entityId') IN (SELECT value FROM json_each(?))", [list(entityIds)]).map((p) => p.roomId))];
      const [where, params] = this.ownedBy();
      return this.byIds<Room>("rooms", roomIds, where, params).map((room) => room.id);
    });
  }

  createRooms(rooms: Room[]): Promise<UUID[]> {
    return this.run("createRooms", () =>
      this.atomic(() =>
        rooms.map((room) => {
          this.insert("rooms", room.id, Date.now(), room);
          return room.id;
        })
      ));
  }

  upsertRooms(rooms: Room[]): Promise<void> {
    return this.run("upsertRooms", () =>
      this.atomic(() => {
        for (const room of rooms) {
          const existing = this.row("rooms", room.id);
          this.put("rooms", room.id, existing?.createdAt ?? Date.now(), { ...(existing ? parse<Room>(existing) : {}), ...room });
        }
      }));
  }

  updateRooms(rooms: Room[]): Promise<void> {
    return this.run("updateRooms", () =>
      this.atomic(() => {
        for (const room of rooms) {
          const existing = this.row("rooms", room.id);
          if (existing) this.replace("rooms", room.id, { ...parse<Room>(existing), ...room });
        }
      }));
  }

  getParticipantsForRooms(roomIds: UUID[]): Promise<ParticipantsForRoomsResult> {
    return this.run("getParticipantsForRooms", () =>
      roomIds.map((roomId) => ({
        roomId,
        entityIds: [...new Set(this.participants("json_extract(body, '$.roomId') = ?", [roomId]).map((p) => p.entityId))],
      })));
  }

  getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]> {
    return this.run("getParticipantsForEntities", () =>
      this.participants("json_extract(body, '$.entityId') IN (SELECT value FROM json_each(?))", [list(entityIds)]).flatMap((participant) => {
        const entity = this.row("entities", participant.entityId);
        return entity ? [{ id: participant.id, entity: parse<Entity>(entity) }] : [];
      }));
  }

  private participant(roomId: UUID, entityId: UUID): Row | undefined {
    return this.rows(`SELECT ${COLUMNS} FROM participants WHERE natural_key = ?`, list([roomId, entityId]))[0];
  }

  createRoomParticipants(entityIds: UUID[], roomId: UUID): Promise<UUID[]> {
    return this.run("createRoomParticipants", () =>
      this.atomic(() =>
        entityIds.map((entityId) => {
          const id = randomUUID() as UUID;
          const participant: StoredParticipant = { id, entityId, roomId };
          this.connection
            .prepare("INSERT INTO participants (id, created_at, natural_key, body) VALUES (?, ?, ?, ?) ON CONFLICT (natural_key) DO NOTHING")
            .run(id, Date.now(), list([roomId, entityId]), JSON.stringify(participant));
          return (this.participant(roomId, entityId)?.id ?? id);
        })
      ));
  }

  deleteParticipants(participants: Array<{ entityId: UUID; roomId: UUID }>): Promise<boolean> {
    return this.run("deleteParticipants", () =>
      this.atomic(() =>
        participants.reduce((removed, { entityId, roomId }) => {
          const existing = this.participant(roomId, entityId);
          return existing ? this.remove("participants", [existing.id]) > 0 || removed : removed;
        }, false)
      ));
  }

  areRoomParticipants(pairs: Array<{ roomId: UUID; entityId: UUID }>): Promise<boolean[]> {
    return this.run("areRoomParticipants", () => pairs.map(({ roomId, entityId }) => this.participant(roomId, entityId) !== undefined));
  }

  getParticipantUserStates(pairs: Array<{ roomId: UUID; entityId: UUID }>): Promise<ParticipantUserState[]> {
    return this.run("getParticipantUserStates", () =>
      pairs.map(({ roomId, entityId }) => {
        const existing = this.participant(roomId, entityId);
        return existing ? (parse<StoredParticipant>(existing).roomState ?? null) : null;
      }));
  }

  updateParticipantUserStates(updates: Array<{ roomId: UUID; entityId: UUID; state: ParticipantUserState }>): Promise<void> {
    return this.run("updateParticipantUserStates", () =>
      this.atomic(() => {
        for (const { roomId, entityId, state } of updates) {
          const existing = this.participant(roomId, entityId);
          if (existing) this.replace("participants", existing.id, { ...parse<StoredParticipant>(existing), roomState: state });
        }
      }));
  }

  private relationships(where: string, params: SQLInputValue[]): Relationship[] {
    const [owned, ownedParams] = this.ownedBy();
    return this.select<Relationship>("relationships", `${where} AND ${owned}`, [...params, ...ownedParams]);
  }

  getRelationshipsByPairs(pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>): Promise<(Relationship | null)[]> {
    return this.run("getRelationshipsByPairs", () =>
      pairs.map((pair) =>
        this.relationships("json_extract(body, '$.sourceEntityId') = ? AND json_extract(body, '$.targetEntityId') = ?", [pair.sourceEntityId, pair.targetEntityId])[0] ?? null
      ));
  }

  getRelationships(params: { entityIds?: UUID[]; tags?: string[]; limit?: number; offset?: number }): Promise<Relationship[]> {
    return this.run("getRelationships", () => {
      const relationships = this.relationships(
        "(? IS NULL OR json_extract(body, '$.sourceEntityId') IN (SELECT value FROM json_each(?)) OR json_extract(body, '$.targetEntityId') IN (SELECT value FROM json_each(?)))",
        [params.entityIds ? 1 : null, list(params.entityIds ?? []), list(params.entityIds ?? [])],
      ).filter((relationship) => !params.tags?.length || params.tags.some((tag) => relationship.tags.includes(tag)));
      const start = params.offset ?? 0;
      return relationships.slice(start, params.limit === undefined ? undefined : start + params.limit);
    });
  }

  getRelationshipsByIds(relationshipIds: UUID[]): Promise<Relationship[]> {
    return this.run("getRelationshipsByIds", () => this.byIds<Relationship>("relationships", relationshipIds));
  }

  createRelationships(relationships: Array<{ sourceEntityId: UUID; targetEntityId: UUID; tags?: string[]; metadata?: Metadata }>): Promise<UUID[]> {
    return this.run("createRelationships", () =>
      this.atomic(() => {
        const agentId = this.agentId();
        return relationships.flatMap((relationship) => {
          const now = Date.now();
          const stored: Relationship = {
            id: randomUUID(),
            sourceEntityId: relationship.sourceEntityId,
            targetEntityId: relationship.targetEntityId,
            agentId,
            tags: relationship.tags ?? [],
            metadata: relationship.metadata ?? {},
            createdAt: new Date(now).toISOString(),
          };
          const result = this.connection
            .prepare("INSERT INTO relationships (id, created_at, natural_key, body) VALUES (?, ?, ?, ?) ON CONFLICT (natural_key) DO NOTHING")
            .run(stored.id, now, list([stored.sourceEntityId, stored.targetEntityId, agentId]), JSON.stringify(stored));
          return Number(result.changes) === 1 ? [stored.id] : [];
        });
      }));
  }

  updateRelationships(relationships: Relationship[]): Promise<void> {
    return this.run("updateRelationships", () =>
      this.atomic(() => {
        for (const relationship of relationships) {
          const existing = this.row("relationships", relationship.id);
          if (!existing) continue;
          const stored = parse<Relationship>(existing);
          if (this.owner && stored.agentId !== this.owner) continue;
          this.replace("relationships", relationship.id, {
            ...stored,
            sourceEntityId: relationship.sourceEntityId,
            targetEntityId: relationship.targetEntityId,
            tags: relationship.tags,
            metadata: relationship.metadata ?? stored.metadata,
          });
        }
      }));
  }

  private memoryRow(id: string): { row: Row; memory: Memory } | undefined {
    const row = this.row("memories", id);
    return row ? { row, memory: parse<Memory>(row) } : undefined;
  }

  private insertMemory(memory: Memory & { id: UUID }, tableName: string): void {
    this.insert("memories", memory.id, memory.createdAt ?? Date.now(), memory, tableName);
  }

  private readable(memories: Memory[], tableName: string | undefined, accessContext: AccessContext | undefined, unstamped?: "room"): Memory[] {
    if (!accessContext) return memories;
    const scope = unstamped ?? (tableName === "messages" && accessContext.authorizedRoomIds !== undefined ? "room" : "private");
    return filterMemoryReadByAccessContext(memories, accessContext, this.agentId(), scope);
  }

  getMemories(params: {
    entityId?: UUID;
    authorEntityIds?: UUID[];
    agentId?: UUID;
    limit?: number;
    count?: number;
    offset?: number;
    cursor?: { createdAt: number; id: UUID };
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
    roomId?: UUID;
    excludeRoomIds?: UUID[];
    worldId?: UUID;
    metadata?: Record<string, unknown>;
    textContains?: string;
    orderBy?: "createdAt";
    orderDirection?: "asc" | "desc";
    includeEmbedding?: boolean;
    accessContext?: AccessContext;
  }): Promise<Memory[]> {
    return this.run("getMemories", () => {
      if (params.cursor && params.offset !== undefined) throw new Error("getMemories cursor and offset are mutually exclusive");
      const ascending = params.orderDirection === "asc";
      const direction = ascending ? "ASC" : "DESC";
      const roomIds = params.entityId ? this.participants("json_extract(body, '$.entityId') = ?", [params.entityId]).map((p) => p.roomId) : null;
      const text = params.textContains?.trim().toLowerCase();
      const conditions: Array<[string, SQLInputValue[]]> = [
        ["scope = ?", [params.tableName]],
        ["(? IS NULL OR json_extract(body, '$.roomId') IN (SELECT value FROM json_each(?)))", [roomIds ? 1 : null, list(roomIds ?? [])]],
        ["(? IS NULL OR json_extract(body, '$.agentId') = ?)", [params.agentId ?? null, params.agentId ?? null]],
        ["(? IS NULL OR json_extract(body, '$.entityId') IN (SELECT value FROM json_each(?)))", [params.authorEntityIds ? 1 : null, list(params.authorEntityIds ?? [])]],
        ["(? IS NULL OR json_extract(body, '$.roomId') = ?)", [params.roomId ?? null, params.roomId ?? null]],
        ["json_extract(body, '$.roomId') NOT IN (SELECT value FROM json_each(?))", [list(params.excludeRoomIds ?? [])]],
        ["(? IS NULL OR json_extract(body, '$.worldId') = ?)", [params.worldId ?? null, params.worldId ?? null]],
        ["(? IS NULL OR created_at >= ?)", [Number.isFinite(params.start) ? 1 : null, params.start ?? 0]],
        ["(? IS NULL OR created_at <= ?)", [Number.isFinite(params.end) ? 1 : null, params.end ?? 0]],
        ["(? IS NULL OR json_extract(body, '$.unique') = 1)", [params.unique ? 1 : null]],
        ["(? IS NULL OR instr(lower(json_extract(body, '$.content.text')), ?) > 0)", [text ? 1 : null, text ?? ""]],
      ];
      const memories = this.select<Memory>(
        "memories",
        conditions.map(([condition]) => condition).join(" AND "),
        conditions.flatMap(([, values]) => values),
        `created_at ${direction}, lower(id) ${direction}`,
      ).filter((memory) => matchesMetadata(memory.metadata, params.metadata));
      let page = this.readable(memories, params.tableName, params.accessContext);
      const cursor = params.cursor;
      if (cursor) {
        page = page.filter((memory) => {
          const createdAt = memory.createdAt ?? 0;
          if (createdAt !== cursor.createdAt) return ascending ? createdAt > cursor.createdAt : createdAt < cursor.createdAt;
          const order = (memory.id ?? "").toLowerCase().localeCompare(cursor.id.toLowerCase());
          return ascending ? order > 0 : order < 0;
        });
      }
      const start = params.offset ?? 0;
      const limit = params.limit ?? params.count;
      page = page.slice(start, limit === undefined ? undefined : start + limit);
      return params.includeEmbedding === false ? page.map(withoutEmbedding) : page;
    });
  }

  getMemoriesByRoomIds(params: {
    tableName: string;
    roomIds: UUID[];
    limit?: number;
    offset?: number;
    textContains?: string;
    includeEmbedding?: boolean;
    accessContext?: AccessContext;
  }): Promise<Memory[]> {
    return this.run("getMemoriesByRoomIds", () => {
      const text = params.textContains?.trim().toLowerCase();
      const memories = this.select<Memory>(
        "memories",
        "scope = ? AND json_extract(body, '$.roomId') IN (SELECT value FROM json_each(?)) AND (? IS NULL OR instr(lower(json_extract(body, '$.content.text')), ?) > 0)",
        [params.tableName, list(params.roomIds), text ? 1 : null, text ?? ""],
        "created_at DESC, lower(id) DESC",
      );
      const start = params.offset ?? 0;
      const page = this.readable(memories, params.tableName, params.accessContext).slice(start, params.limit === undefined ? undefined : start + params.limit);
      return params.includeEmbedding === false ? page.map(withoutEmbedding) : page;
    });
  }

  searchMessages(params: {
    roomIds: UUID[];
    query: string;
    tableName?: string;
    limit?: number;
    offset?: number;
    since?: number;
    until?: number;
    accessContext?: AccessContext;
  }): Promise<MessageSearchHit[]> {
    return this.run("searchMessages", () => {
      const candidates = this.select<Memory>(
        "memories",
        "scope = ? AND json_extract(body, '$.roomId') IN (SELECT value FROM json_each(?))",
        [params.tableName ?? "messages", list(params.roomIds)],
      ).filter((memory) => withinCreatedAtWindow(memory.createdAt, params.since, params.until));
      const start = params.offset ?? 0;
      return rankMessageSearch(this.readable(candidates, params.tableName, params.accessContext, "room"), params.query)
        .slice(start, start + (params.limit ?? 20))
        .map(({ item, ftsRank, trigramSimilarity }) => ({ memory: item, ftsRank, trigramSimilarity }));
    });
  }

  getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    return this.run("getMemoriesByIds", () => this.byIds<Memory>("memories", memoryIds, "(? IS NULL OR t.scope = ?)", [tableName ?? null, tableName ?? null]));
  }

  getCachedEmbeddings(params: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return this.run("getCachedEmbeddings", () =>
      this.select<Memory>("memories", "scope = ? AND json_array_length(body, '$.embedding') > 0", [params.query_table_name])
        .flatMap((memory) => {
          const field = (memory.content as Record<string, unknown>)[params.query_field_sub_name];
          if (typeof field !== "string" || !memory.embedding) return [];
          const score = levenshtein(params.query_input, field);
          return score <= params.query_threshold ? [{ embedding: memory.embedding, levenshtein_score: score }] : [];
        })
        .sort((left, right) => left.levenshtein_score - right.levenshtein_score)
        .slice(0, params.query_match_count));
  }

  searchMemories(params: {
    tableName: string;
    embedding: number[];
    includeEmbedding?: boolean;
    excludeRoomIds?: UUID[];
    match_threshold?: number;
    count?: number;
    limit?: number;
    offset?: number;
    unique?: boolean;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
    accessContext?: AccessContext;
  }): Promise<Memory[]> {
    return this.run("searchMemories", () => {
      const limit = params.count ?? params.limit;
      const start = params.offset ?? 0;
      if (!Number.isSafeInteger(start) || start < 0) throw new Error("searchMemories offset must be a non-negative safe integer");
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("searchMemories limit must be a non-negative safe integer");
      const threshold = params.match_threshold ? params.match_threshold : Number.NEGATIVE_INFINITY;
      const ranked = this.connection
        .prepare(
          `SELECT ${COLUMNS}, cosine_similarity(json_extract(body, '$.embedding'), ?) AS similarity FROM memories
           WHERE scope = ? AND json_array_length(body, '$.embedding') = ?
           AND (? IS NULL OR json_extract(body, '$.roomId') = ?)
           AND json_extract(body, '$.roomId') NOT IN (SELECT value FROM json_each(?))
           AND (? IS NULL OR json_extract(body, '$.worldId') = ?)
           AND (? IS NULL OR json_extract(body, '$.entityId') = ?)
           AND (? IS NULL OR json_extract(body, '$.unique') = 1)
           ORDER BY similarity DESC, created_at DESC, lower(id) DESC`,
        )
        .all(
          JSON.stringify(params.embedding),
          params.tableName,
          params.embedding.length,
          params.roomId ?? null,
          params.roomId ?? null,
          list(params.excludeRoomIds ?? []),
          params.worldId ?? null,
          params.worldId ?? null,
          params.entityId ?? null,
          params.entityId ?? null,
          params.unique ? 1 : null,
        )
        .map((record) => ({ ...parse<Memory>(toRow(record)), similarity: Number(record.similarity) }));
      const page = this.readable(ranked, params.tableName, params.accessContext)
        .filter((memory) => (memory.similarity ?? 0) >= threshold)
        .slice(start, limit === undefined ? undefined : start + limit);
      const reranked = rerankMemories(params.query, page);
      return params.includeEmbedding === false ? reranked.map(withoutEmbedding) : reranked;
    });
  }

  createMemories(memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>): Promise<UUID[]> {
    return this.run("createMemories", () =>
      this.atomic(() =>
        memories.map(({ memory, tableName, unique }) => {
          const id = memory.id ?? randomUUID();
          this.insertMemory(
            {
              ...memory,
              id,
              agentId: memory.agentId ?? this.agentId(),
              unique: unique ?? memory.unique ?? true,
              createdAt: memory.createdAt ?? Date.now(),
              metadata: { ...(memory.metadata ?? {}) },
            },
            tableName,
          );
          return id;
        })
      ));
  }

  updateMemories(memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>): Promise<void> {
    return this.run("updateMemories", () =>
      this.atomic(() => {
        for (const memory of memories) {
          const existing = this.memoryRow(memory.id);
          if (existing) this.replace("memories", memory.id, { ...existing.memory, ...memory, metadata: memory.metadata ?? existing.memory.metadata });
        }
      }));
  }

  upsertMemories(memories: Array<{ memory: Memory; tableName: string }>, _options?: { entityContext?: UUID }): Promise<void> {
    return this.run("upsertMemories", () =>
      this.atomic(() => {
        for (const { memory, tableName } of memories) {
          const id = memory.id ?? randomUUID();
          const existing = this.memoryRow(id)?.memory;
          const stored: Memory = {
            ...existing,
            ...memory,
            id,
            agentId: memory.agentId ?? existing?.agentId ?? this.agentId(),
            createdAt: memory.createdAt ?? existing?.createdAt ?? Date.now(),
            metadata: { ...(existing?.metadata ?? {}), ...(memory.metadata ?? {}) } as MemoryMetadata,
          };
          this.put("memories", id, stored.createdAt ?? Date.now(), stored, tableName);
        }
      }));
  }

  updateMemoryEmbedding(update: MemoryEmbeddingUpdate): Promise<boolean> {
    return this.run("updateMemoryEmbedding", () =>
      this.atomic(() => {
        const current = this.memoryRow(update.id);
        const expected = update.expected;
        if (
          !current
          || current.memory.agentId !== expected.agentId
          || current.memory.roomId !== expected.roomId
          || current.memory.entityId !== expected.entityId
          || current.memory.content.text !== expected.text
        ) {
          return false;
        }
        if (update.embedding.length !== this.dimension() || !update.embedding.every(Number.isFinite)) {
          throw new Error("Invalid memory embedding for active dimension");
        }
        return this.replace("memories", update.id, { ...current.memory, embedding: [...update.embedding] }, current.row.revision);
      }));
  }

  deleteMemories(memoryIds: UUID[]): Promise<void> {
    return this.run("deleteMemories", () =>
      this.atomic(() => {
        this.connection
          .prepare(
            `DELETE FROM memories WHERE id IN (SELECT value FROM json_each(?1))
             OR (scope = '${MESSAGE_CONTENT_SEGMENT_TABLE}' AND json_extract(body, '$.metadata.messageId') IN (SELECT value FROM json_each(?1)))
             OR (scope = 'document_fragments' AND json_extract(body, '$.metadata.documentId') IN (SELECT value FROM json_each(?1)))`,
          )
          .run(list(memoryIds));
      }));
  }

  countMemories(params: { roomIds?: UUID[]; unique?: boolean; tableName?: string; entityId?: UUID; agentId?: UUID; metadata?: Record<string, unknown> }): Promise<number> {
    return this.run("countMemories", () =>
      this.select<Memory>(
        "memories",
        "(? IS NULL OR json_extract(body, '$.roomId') IN (SELECT value FROM json_each(?))) AND (? IS NULL OR json_extract(body, '$.unique') = 1) AND (? IS NULL OR scope = ?) AND (? IS NULL OR json_extract(body, '$.entityId') = ?) AND (? IS NULL OR json_extract(body, '$.agentId') = ?)",
        [
          params.roomIds ? 1 : null,
          list(params.roomIds ?? []),
          params.unique ? 1 : null,
          params.tableName ?? null,
          params.tableName ?? null,
          params.entityId ?? null,
          params.entityId ?? null,
          params.agentId ?? null,
          params.agentId ?? null,
        ],
      ).filter((memory) => matchesMetadata(memory.metadata, params.metadata)).length);
  }

  private meta<T>(key: string): T | undefined {
    const found = this.row("meta", key);
    return found ? parse<T>(found) : undefined;
  }

  private dimension(): number {
    return this.meta<number>("embedding_dimension") ?? 384;
  }

  ensureEmbeddingDimension(dimension: number): Promise<void> {
    return this.run("ensureEmbeddingDimension", () => {
      if (!Number.isSafeInteger(dimension) || dimension <= 0) {
        throw new ElizaError("Embedding dimension must be a positive integer", { code: "SQLITE_EMBEDDING_DIMENSION_INVALID" });
      }
      if (this.meta<string>("embedding_space") !== undefined && this.dimension() !== dimension) {
        throw new ElizaError("A named embedding representation cannot change dimensions", { code: "EMBEDDING_SPACE_CHANGED" });
      }
      this.put("meta", "embedding_dimension", Date.now(), dimension);
    });
  }

  ensureEmbeddingSpace(spaceId: string): Promise<UUID[]> {
    return this.run("ensureEmbeddingSpace", () =>
      this.atomic(() => {
        if (!spaceId.trim() || spaceId !== spaceId.trim()) {
          throw new ElizaError("Embedding representation requires a canonical identifier", { code: "EMBEDDING_SPACE_INVALID" });
        }
        const active = this.meta<string>("embedding_space");
        if (active !== undefined && active !== spaceId) {
          throw new ElizaError("Use a separate database or migrate its named embedding representation", { code: "EMBEDDING_SPACE_CHANGED" });
        }
        if (active === undefined) this.connection.exec("UPDATE memories SET body = json_remove(body, '$.embedding'), revision = revision + 1 WHERE json_type(body, '$.embedding') IS NOT NULL");
        this.put("meta", "embedding_space", Date.now(), spaceId);
        return this.rows(
          `SELECT ${COLUMNS} FROM memories WHERE json_extract(body, '$.content.text') <> '' AND coalesce(json_array_length(body, '$.embedding'), 0) = 0 ORDER BY created_at, rowid`,
        ).map((row) => row.id);
      }));
  }

  clearEmbeddingsOutsideActiveDimension(): Promise<UUID[]> {
    return this.run("clearEmbeddingsOutsideActiveDimension", () =>
      this.atomic(() => {
        const stale = this.rows(
          `SELECT ${COLUMNS} FROM memories WHERE json_array_length(body, '$.embedding') > 0 AND json_array_length(body, '$.embedding') <> ? ORDER BY created_at, rowid`,
          this.dimension(),
        ).map((row) => row.id);
        this.connection
          .prepare("UPDATE memories SET body = json_remove(body, '$.embedding'), revision = revision + 1 WHERE id IN (SELECT value FROM json_each(?))")
          .run(list(stale));
        return stale;
      }));
  }

  publishMessageContentSegments(params: MessageContentPublicationParams): Promise<MessageContentPublicationResult> {
    return this.run("publishMessageContentSegments", () =>
      this.atomic((): MessageContentPublicationResult => {
        const parentId = params.mode === "create" ? params.parent.id : params.messageId;
        const agentId = params.mode === "create" ? params.parent.agentId : params.agentId;
        if (!agentId) {
          throw new ElizaError("Message content publication requires parent and agent IDs", { code: "MESSAGE_CONTENT_PUBLICATION_INVALID" });
        }
        const existing = this.memoryRow(parentId);
        if (params.mode === "create" && existing) return { status: "conflict" };
        const removed = params.mode === "replace" ? params.removeSegmentIds : [];
        if (params.mode === "replace") {
          if (!existing || existing.row.scope !== "messages" || existing.memory.agentId !== params.agentId) return { status: "not_found" };
          if (JSON.stringify(existing.memory.content) !== JSON.stringify(params.expectedContent)) return { status: "conflict" };
          for (const segmentId of removed) {
            const metadata = this.memoryRow(segmentId)?.memory.metadata as Record<string, unknown> | undefined;
            if (metadata?.type !== "message-content-segment" || metadata.messageId !== params.messageId) {
              throw new ElizaError("Message content replacement cannot remove an unrelated or missing segment", {
                code: "MESSAGE_CONTENT_DELETE_INCOMPLETE",
                context: { messageId: params.messageId, segmentId },
              });
            }
          }
        }
        const seen = new Set<string>();
        for (const segment of params.segments) {
          if (!segment.id || segment.agentId !== agentId) {
            throw new ElizaError("Message content segment identity is invalid", { code: "MESSAGE_CONTENT_PUBLICATION_INVALID", context: { messageId: parentId } });
          }
          if (seen.has(segment.id) || (this.row("memories", segment.id) && !removed.includes(segment.id))) {
            throw new ElizaError("Message content segment id already exists", {
              code: "MESSAGE_CONTENT_SEGMENT_ID_CONFLICT",
              context: { messageId: parentId, segmentId: segment.id },
            });
          }
          seen.add(segment.id);
        }
        const now = Date.now();
        this.remove("memories", removed);
        for (const segment of params.segments) {
          this.insertMemory({ ...segment, id: segment.id as UUID, agentId, createdAt: segment.createdAt ?? now }, MESSAGE_CONTENT_SEGMENT_TABLE);
        }
        if (params.mode === "create") {
          this.insertMemory({ ...params.parent, agentId, unique: params.parent.unique ?? true, createdAt: params.parent.createdAt ?? now }, "messages");
        } else if (existing) {
          this.replace("memories", parentId, { ...existing.memory, content: params.replacementContent }, existing.row.revision);
        }
        const parent = this.memoryRow(parentId);
        if (!parent) throw new ElizaError("Failed to publish atomic message content", { code: "MESSAGE_CONTENT_PUBLICATION_FAILED", context: { messageId: parentId } });
        return { status: params.mode === "create" ? "created" : "updated", parent: parent.memory, removedSegmentIds: [...removed] };
      }));
  }

  readMessageContentRange(params: MessageContentRangeReadParams): Promise<MessageContentRangeReadResult> {
    return this.run("readMessageContentRange", (): MessageContentRangeReadResult => {
      if (!Number.isSafeInteger(params.offset) || params.offset < 0 || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES) {
        throw new ElizaError("Message content range is invalid", { code: "MESSAGE_CONTENT_INVALID_RANGE" });
      }
      const stored = this.memoryRow(params.messageId);
      if (!stored || stored.row.scope !== "messages" || stored.memory.agentId !== params.agentId || stored.memory.roomId !== params.authorizedRoomId) {
        return { status: "not_found" };
      }
      const parent = stored.memory;
      const authorized = authorizeMessageContentReadOrThrow({
        parent,
        authorizedRoomId: params.authorizedRoomId,
        requester: params.accessContext,
        agentId: params.agentId,
        participantCurrent: this.participant(parent.roomId, params.accessContext.requesterEntityId) !== undefined,
        selector: params.source,
      });
      if (!authorized) return { status: "forbidden" };
      const descriptor = resolveMessageContentSourceDescriptorOrThrow(parent.content, params.source);
      if (!descriptor) {
        const attachment = (parent.content.attachments ?? []).find((item) => hashAttachmentIdForLocator(item.id) === params.source.attachmentIdHash);
        const text = params.source.kind === "message-text" ? (parent.content.text ?? "") : attachment ? canonicalAttachmentText(attachment) : "";
        if (new TextEncoder().encode(text).length > MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES) {
          throw new ElizaError("Legacy content requires explicit segmented reindexing", {
            code: params.source.kind === "message-text" ? "MESSAGE_REINDEX_REQUIRED" : "ATTACHMENT_REINDEX_REQUIRED",
            context: { messageId: params.messageId },
          });
        }
        return { status: "inline", parent, text };
      }
      if (params.offset > 0 && !params.expectedRevision) {
        throw new ElizaError("Message content continuation requires a revision", { code: "MESSAGE_CONTENT_EXPECTED_REVISION_REQUIRED" });
      }
      if (params.expectedRevision && params.expectedRevision !== descriptor.revision) {
        throw new ElizaError("Message content changed before continuation", { code: "MESSAGE_CONTENT_STALE_REVISION", context: { messageId: params.messageId } });
      }
      const requestedEnd = Math.min(params.offset + params.limit, descriptor.byteLength);
      const segments = this.select<Memory>(
        "memories",
        `scope = ? AND json_extract(body, '$.agentId') = ? AND json_extract(body, '$.metadata.type') = 'message-content-segment'
         AND json_extract(body, '$.metadata.messageId') = ? AND json_extract(body, '$.metadata.sourceKind') = ?
         AND json_extract(body, '$.metadata.attachmentIdHash') IS ? AND json_extract(body, '$.metadata.sourceRevision') = ?
         AND json_extract(body, '$.metadata.byteEnd') > ? AND json_extract(body, '$.metadata.byteStart') < ?`,
        [
          MESSAGE_CONTENT_SEGMENT_TABLE,
          params.agentId,
          params.messageId,
          params.source.kind,
          params.source.attachmentIdHash ?? null,
          descriptor.revision,
          params.offset,
          requestedEnd,
        ],
        "json_extract(body, '$.metadata.byteStart')",
      );
      return {
        status: "ok",
        parent,
        page: readMessageContentProjectionOrThrow({
          descriptor,
          segments: segments.slice(0, MESSAGE_CONTENT_READ_MAX_SEGMENTS),
          messageId: params.messageId,
          offset: params.offset,
          limit: params.limit,
          sourceQueryCount: 0,
        }),
      };
    });
  }

  getLogs(params: { entityId?: UUID; roomId?: UUID; type?: string; limit?: number; offset?: number }): Promise<Log[]> {
    return this.run("getLogs", () => {
      const logs = this.rows(
        `SELECT ${COLUMNS} FROM logs WHERE (? IS NULL OR json_extract(body, '$.entityId') = ?) AND (? IS NULL OR json_extract(body, '$.roomId') = ?) AND (? IS NULL OR json_extract(body, '$.type') = ?) ORDER BY created_at DESC, lower(id) DESC`,
        params.entityId ?? null,
        params.entityId ?? null,
        params.roomId ?? null,
        params.roomId ?? null,
        params.type ?? null,
        params.type ?? null,
      ).map((row): Log => ({ ...parse<StoredLog>(row), createdAt: new Date(row.createdAt) }));
      const start = params.offset ?? 0;
      return logs.slice(start, params.limit === undefined ? undefined : start + params.limit);
    });
  }

  createLogs(params: Array<{ body: LogBody; entityId: UUID; roomId: UUID; type: string; createdAt?: Date }>): Promise<void> {
    return this.run("createLogs", () =>
      this.atomic(() => {
        for (const entry of params) {
          const log: StoredLog = { id: randomUUID(), type: entry.type, entityId: entry.entityId, roomId: entry.roomId, body: entry.body };
          this.insert("logs", log.id, entry.createdAt?.getTime() ?? Date.now(), log);
        }
      }));
  }

  private cacheId(key: string): string {
    return list([this.agentId(), key]);
  }

  getCaches<T>(keys: string[]): Promise<Map<string, T>> {
    return this.run("getCaches", () => {
      const found = new Map<string, T>();
      for (const key of keys) {
        const stored = this.row("caches", this.cacheId(key));
        if (stored) found.set(key, parse<{ value: T }>(stored).value);
      }
      return found;
    });
  }

  setCaches<T>(entries: Array<{ key: string; value: T }>): Promise<boolean> {
    return this.run("setCaches", () =>
      this.atomic(() => {
        for (const { key, value } of entries) this.put("caches", this.cacheId(key), Date.now(), { value });
        return true;
      }));
  }

  deleteCaches(keys: string[]): Promise<boolean> {
    return this.run("deleteCaches", () => {
      this.remove("caches", keys.map((key) => this.cacheId(key)));
      return true;
    });
  }

  override compareAndSetCache<T>(key: string, expected: unknown, replacement: T): Promise<boolean> {
    return this.run("compareAndSetCache", () =>
      this.atomic(() => {
        const value = JSON.parse(encodeCacheCasValueOrThrow(replacement)) as unknown;
        const id = this.cacheId(key);
        const stored = this.row("caches", id);
        if (expected === undefined) {
          if (stored) return false;
          const result = this.connection
            .prepare("INSERT INTO caches (id, created_at, body) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING")
            .run(id, Date.now(), JSON.stringify({ value }));
          return Number(result.changes) === 1;
        }
        if (!stored || encodeCacheCasValueOrThrow(parse<{ value: unknown }>(stored).value) !== encodeCacheCasValueOrThrow(expected)) return false;
        return this.replace("caches", id, { value }, stored.revision);
      }));
  }

  private tasks(where: string, params: SQLInputValue[]): Task[] {
    const [owned, ownedParams] = this.ownedBy();
    return this.select<Task>("tasks", `${where} AND ${owned}`, [...params, ...ownedParams], "created_at, lower(id)");
  }

  getTasks(params: { roomId?: UUID; worldId?: UUID; tags?: string[]; entityId?: UUID; agentIds: UUID[]; limit?: number; offset?: number }): Promise<Task[]> {
    return this.run("getTasks", () => {
      validateTaskQueryPaginationOrThrow(params);
      const tasks = this.select<Task>(
        "tasks",
        "json_extract(body, '$.agentId') IN (SELECT value FROM json_each(?)) AND (? IS NULL OR json_extract(body, '$.roomId') = ?) AND (? IS NULL OR json_extract(body, '$.worldId') = ?) AND (? IS NULL OR json_extract(body, '$.entityId') = ?)",
        [list(params.agentIds), params.roomId ?? null, params.roomId ?? null, params.worldId ?? null, params.worldId ?? null, params.entityId ?? null, params.entityId ?? null],
        "created_at, lower(id)",
      ).filter((task) => (params.tags ?? []).every((tag) => task.tags?.includes(tag)));
      const start = params.offset ?? 0;
      return tasks.slice(start, params.limit === undefined ? undefined : start + params.limit);
    });
  }

  getTasksByName(name: string): Promise<Task[]> {
    return this.run("getTasksByName", () => this.tasks("json_extract(body, '$.name') = ?", [name]));
  }

  getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
    return this.run("getTasksByIds", () => {
      const [owned, ownedParams] = this.ownedBy();
      return this.byIds<Task>("tasks", taskIds, owned, ownedParams);
    });
  }

  createTasks(tasks: Task[]): Promise<UUID[]> {
    return this.run("createTasks", () =>
      this.atomic(() =>
        tasks.map((task) => {
          if (WAKE_KEYS.some((key) => Object.hasOwn(task.metadata ?? {}, key))) throw authoredWake();
          const id = task.id ?? randomUUID();
          const createdAt = typeof task.createdAt === "number" || typeof task.createdAt === "bigint" ? Number(task.createdAt) : Date.now();
          this.insert("tasks", id, createdAt, { ...task, id, agentId: task.agentId ?? this.agentId(), createdAt });
          return id;
        })
      ));
  }

  private ownTask(id: UUID): { row: Row; task: Task } | undefined {
    const row = this.row("tasks", id);
    const task = row ? parse<Task>(row) : undefined;
    return row && task && (!this.owner || !task.agentId || task.agentId === this.owner) ? { row, task } : undefined;
  }

  updateTasks(updates: Array<{ id: UUID; task: Partial<Task> }>): Promise<void> {
    return this.run("updateTasks", () =>
      this.atomic(() => {
        for (const { id, task } of updates) {
          const existing = this.ownTask(id);
          if (existing) this.replace("tasks", id, withKeptWake(existing.task, task));
        }
      }));
  }

  deleteTasks(taskIds: UUID[]): Promise<void> {
    return this.run("deleteTasks", () => {
      this.remove("tasks", taskIds.filter((id) => this.ownTask(id)));
    });
  }

  override updatePendingTask(id: UUID, task: Partial<Task>): Promise<boolean> {
    return this.run("updatePendingTask", () =>
      this.atomic(() => {
        const existing = this.ownTask(id);
        const status = existing?.task.metadata?.status;
        if (!existing || !existing.task.tags?.includes("queue") || (status != null && status !== "pending")) return false;
        return this.replace("tasks", id, { ...withKeptWake(existing.task, task), id }, existing.row.revision);
      }));
  }

  patchTaskMetadata(id: UUID, patch: TaskMetadataPatch): Promise<boolean> {
    return this.run("patchTaskMetadata", () => {
      if (WAKE_KEYS.some((key) => Object.hasOwn(patch.set ?? {}, key) || patch.unset?.includes(key))) throw authoredWake();
      const wake = patch.wake;
      if (wake) {
        if ([wake.requestAt, wake.consumeRevision].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
          throw new ElizaError("Task wake requires nonnegative safe integer milliseconds/revision", { code: "TASK_WAKE_INVALID" });
        }
        if (wake.requestAt === undefined && wake.consumeRevision === undefined) throw new ElizaError("Empty task wake operation", { code: "TASK_WAKE_INVALID" });
      }
      return this.atomic(() => {
        const existing = this.ownTask(id);
        if (!existing) return false;
        const stored = existing.task.metadata ?? {};
        const metadata: TaskMetadata = { ...stored, ...(patch.set ?? {}) };
        for (const key of patch.unset ?? []) delete metadata[key];
        if (wake) {
          const revision = stored.wakeRevision ?? 0;
          const kept = wake.consumeRevision === revision ? undefined : stored.wakeAt;
          const wakeAt = wake.requestAt === undefined ? kept : Math.min(kept ?? wake.requestAt, wake.requestAt);
          delete metadata.wakeAt;
          metadata.wakeRevision = wake.requestAt === undefined ? revision : revision + 1;
          if (wakeAt !== undefined) metadata.wakeAt = wakeAt;
        }
        return this.replace("tasks", id, { ...existing.task, metadata }, existing.row.revision);
      });
    });
  }

  private pairing<T extends { createdAt: Date; lastSeenAt?: Date }>(row: Row): T {
    const stored = parse<StoredPairing<T>>(row);
    return {
      ...stored,
      createdAt: new Date(stored.createdAt),
      ...(stored.lastSeenAt === undefined ? {} : { lastSeenAt: new Date(stored.lastSeenAt) }),
    } as unknown as T;
  }

  private storedPairing<T extends { createdAt: Date; lastSeenAt?: Date }>(value: T): StoredPairing<T> {
    return {
      ...value,
      createdAt: value.createdAt.getTime(),
      ...(value.lastSeenAt === undefined ? {} : { lastSeenAt: value.lastSeenAt.getTime() }),
    };
  }

  getPairingRequests(queries: PairingRequestQuery[]): Promise<PairingRequestsResult> {
    return this.run("getPairingRequests", () =>
      queries.map((query) => {
        const requests = this.rows(
          `SELECT ${COLUMNS} FROM pairing_requests WHERE json_extract(body, '$.channel') = ? AND json_extract(body, '$.agentId') = ? AND created_at >= ? ORDER BY created_at, lower(id)`,
          query.channel,
          query.agentId,
          query.createdAfter?.getTime() ?? Number.MIN_SAFE_INTEGER,
        ).map((row) => this.pairing<PairingRequest>(row));
        const { rows, pageInfo } = pairingPage(requests, query);
        return { channel: query.channel, agentId: query.agentId, requests: rows, ...(pageInfo ? { pageInfo } : {}) };
      }));
  }

  getPairingAllowlists(queries: PairingAllowlistQuery[]): Promise<PairingAllowlistsResult> {
    return this.run("getPairingAllowlists", () =>
      queries.map((query) => {
        const entries = this.rows(
          `SELECT ${COLUMNS} FROM pairing_allowlist WHERE json_extract(body, '$.channel') = ? AND json_extract(body, '$.agentId') = ? ORDER BY created_at, lower(id)`,
          query.channel,
          query.agentId,
        ).map((row) => this.pairing<PairingAllowlistEntry>(row));
        const { rows, pageInfo } = pairingPage(entries, query);
        return { channel: query.channel, agentId: query.agentId, entries: rows, ...(pageInfo ? { pageInfo } : {}) };
      }));
  }

  createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
    return this.run("createPairingRequests", () =>
      this.atomic(() =>
        requests.map((request) => {
          this.insert("pairing_requests", request.id, request.createdAt.getTime(), this.storedPairing(request));
          return request.id;
        })
      ));
  }

  updatePairingRequests(requests: PairingRequest[]): Promise<void> {
    return this.run("updatePairingRequests", () =>
      this.atomic(() => {
        for (const request of requests) {
          const existing = this.row("pairing_requests", request.id);
          if (existing) this.replace("pairing_requests", request.id, { ...parse<StoredPairing<PairingRequest>>(existing), ...this.storedPairing(request) });
        }
      }));
  }

  deletePairingRequests(ids: UUID[]): Promise<void> {
    return this.run("deletePairingRequests", () => {
      this.remove("pairing_requests", ids);
    });
  }

  createPairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<UUID[]> {
    return this.run("createPairingAllowlistEntries", () =>
      this.atomic(() =>
        entries.flatMap((entry) => {
          const naturalKey = list([entry.agentId, entry.channel, entry.senderId]);
          if (this.rows(`SELECT ${COLUMNS} FROM pairing_allowlist WHERE natural_key = ?`, naturalKey).length > 0) return [];
          this.insert("pairing_allowlist", entry.id, entry.createdAt.getTime(), this.storedPairing(entry), null, naturalKey);
          return [entry.id];
        })
      ));
  }

  updatePairingAllowlistEntries(entries: PairingAllowlistEntry[]): Promise<void> {
    return this.run("updatePairingAllowlistEntries", () =>
      this.atomic(() => {
        for (const entry of entries) {
          const existing = this.row("pairing_allowlist", entry.id);
          if (!existing) continue;
          const merged = { ...parse<StoredPairing<PairingAllowlistEntry>>(existing), ...this.storedPairing(entry) };
          this.put("pairing_allowlist", entry.id, existing.createdAt, merged, null, list([merged.agentId, merged.channel, merged.senderId]));
        }
      }));
  }

  deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
    return this.run("deletePairingAllowlistEntries", () => {
      this.remove("pairing_allowlist", ids);
    });
  }

  private account(params: GetConnectorAccountParams): ConnectorAccountRecord | null {
    if (!params.id && (!params.provider || !params.accountKey)) {
      throw new ElizaError("getConnectorAccount requires id or provider + accountKey", { code: "SQLITE_CONNECTOR_INVALID" });
    }
    const found = params.id
      ? this.row("connector_accounts", params.id)
      : this.rows(`SELECT ${COLUMNS} FROM connector_accounts WHERE natural_key = ?`, list([params.agentId ?? this.agentId(), params.provider, params.accountKey]))[0];
    const account = found ? parse<ConnectorAccountRecord>(found) : null;
    return account && account.deletedAt == null ? account : null;
  }

  override listConnectorAccounts(params: ListConnectorAccountsParams = {}): Promise<ConnectorAccountRecord[]> {
    return this.run("listConnectorAccounts", () => {
      const accounts = this.select<ConnectorAccountRecord>(
        "connector_accounts",
        "json_extract(body, '$.agentId') = ? AND json_extract(body, '$.deletedAt') IS NULL AND (? IS NULL OR json_extract(body, '$.provider') = ?) AND (? IS NULL OR json_extract(body, '$.status') = ?)",
        [params.agentId ?? this.agentId(), params.provider ?? null, params.provider ?? null, params.status ?? null, params.status ?? null],
        "json_extract(body, '$.updatedAt') DESC, id",
      );
      const start = params.offset ?? 0;
      return accounts.slice(start, params.limit === undefined ? undefined : start + params.limit);
    });
  }

  override getConnectorAccount(params: GetConnectorAccountParams): Promise<ConnectorAccountRecord | null> {
    return this.run("getConnectorAccount", () => this.account(params));
  }

  private existingAccountId(params: UpsertConnectorAccountParams, agentId: UUID): string | undefined {
    const role = params.role ?? "OWNER";
    const byKey = this.rows(`SELECT ${COLUMNS} FROM connector_accounts WHERE natural_key = ?`, list([agentId, params.provider, params.accountKey]))[0]?.id;
    const byExternal = params.externalId == null
      ? undefined
      : this.select<ConnectorAccountRecord>(
        "connector_accounts",
        "json_extract(body, '$.agentId') = ? AND json_extract(body, '$.provider') = ? AND json_extract(body, '$.externalId') = ? AND json_extract(body, '$.role') = ? AND json_extract(body, '$.deletedAt') IS NULL",
        [agentId, params.provider, params.externalId, role],
      )[0]?.id;
    const requested = params.id ? this.row("connector_accounts", params.id) : undefined;
    if (requested && parse<ConnectorAccountRecord>(requested).deletedAt != null) {
      throw new ElizaError("Connector account id already belongs to a deleted account", { code: "SQLITE_CONNECTOR_INVALID" });
    }
    if (requested) {
      if (byKey && byKey !== requested.id) {
        throw new ElizaError("Connector account id and account key resolve to different accounts", { code: "SQLITE_CONNECTOR_INVALID" });
      }
      if (byExternal && byExternal !== requested.id) {
        throw new ElizaError("Connector account id and external identity resolve to different accounts", { code: "SQLITE_CONNECTOR_INVALID" });
      }
      return requested.id;
    }
    if (params.externalId == null) return byKey;
    if (byKey && byKey !== byExternal) {
      throw new ElizaError("Connector account key and external identity resolve to different accounts", { code: "SQLITE_CONNECTOR_INVALID" });
    }
    return byExternal;
  }

  override upsertConnectorAccount(params: UpsertConnectorAccountParams): Promise<ConnectorAccountRecord> {
    return this.run("upsertConnectorAccount", () =>
      this.atomic(() => {
        const agentId = params.agentId ?? this.agentId();
        const existingId = this.existingAccountId(params, agentId);
        const stored = existingId ? this.row("connector_accounts", existingId) : undefined;
        const existing = stored ? parse<ConnectorAccountRecord>(stored) : undefined;
        const now = Date.now();
        const keep = <V>(next: V | undefined, previous: V | undefined): V | undefined => (next !== undefined ? next : previous);
        const deletedAt = millis(params.deletedAt);
        const record: ConnectorAccountRecord = {
          id: existing?.id ?? params.id ?? randomUUID(),
          agentId,
          provider: params.provider,
          accountKey: params.accountKey,
          externalId: keep(params.externalId, existing?.externalId),
          displayName: keep(params.displayName, existing?.displayName),
          username: keep(params.username, existing?.username),
          email: keep(params.email, existing?.email),
          ownerBindingId: keep(params.ownerBindingId, existing?.ownerBindingId),
          ownerIdentityId: keep(params.ownerIdentityId, existing?.ownerIdentityId),
          role: params.role ?? existing?.role ?? "OWNER",
          purpose: [...(params.purpose ?? existing?.purpose ?? ["messaging"])],
          accessGate: params.accessGate ?? existing?.accessGate ?? "open",
          status: params.status ?? existing?.status ?? "connected",
          scopes: [...(params.scopes ?? existing?.scopes ?? [])],
          capabilities: [...(params.capabilities ?? existing?.capabilities ?? [])],
          profile: cloneConnectorJsonObjectOrThrow(params.profile ?? existing?.profile),
          metadata: cloneConnectorJsonObjectOrThrow(params.metadata ?? existing?.metadata),
          connectedAt: millis(params.connectedAt) ?? existing?.connectedAt ?? now,
          lastSyncAt: params.lastSyncAt !== undefined ? millis(params.lastSyncAt) : existing?.lastSyncAt,
          deletedAt: deletedAt ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        this.put("connector_accounts", record.id, record.createdAt, record, null, deletedAt == null ? list([agentId, record.provider, record.accountKey]) : null);
        return record;
      }));
  }

  override deleteConnectorAccount(params: DeleteConnectorAccountParams): Promise<boolean> {
    return this.run("deleteConnectorAccount", () =>
      this.atomic(() => {
        const account = this.account(params);
        if (!account) return false;
        const now = Date.now();
        this.put("connector_accounts", account.id, account.createdAt, { ...account, status: "disabled", deletedAt: now, updatedAt: now });
        return true;
      }));
  }

  findConnectorOwnerBinding(params: { connector: string; externalId: string; instanceId?: string }): Promise<OwnerBinding | null> {
    return this.run("findConnectorOwnerBinding", () =>
      this.select<OwnerBinding>(
        "owner_bindings",
        "json_extract(body, '$.connector') = ? AND json_extract(body, '$.externalId') = ? AND (? IS NULL OR json_extract(body, '$.instanceId') = ?)",
        [params.connector, params.externalId, params.instanceId ?? null, params.instanceId ?? null],
      )[0] ?? null);
  }

  override appendConnectorAccountAuditEvent(params: AppendConnectorAccountAuditEventParams): Promise<ConnectorAccountAuditEventRecord> {
    return this.run("appendConnectorAccountAuditEvent", () =>
      this.atomic(() => {
        let agentId = params.agentId ?? this.agentId();
        let provider = params.provider;
        if (params.accountId && (!params.agentId || !provider)) {
          const account = this.account({ id: params.accountId });
          if (!account) throw new ElizaError(`Connector account not found: ${params.accountId}`, { code: "SQLITE_CONNECTOR_INVALID" });
          agentId = account.agentId;
          provider = account.provider;
        }
        if (!provider) throw new ElizaError("appendConnectorAccountAuditEvent requires provider or accountId", { code: "SQLITE_CONNECTOR_INVALID" });
        const record: ConnectorAccountAuditEventRecord = {
          id: randomUUID(),
          accountId: params.accountId ?? null,
          agentId,
          provider,
          actorId: params.actorId ?? null,
          action: params.action,
          outcome: params.outcome ?? "success",
          metadata: redactConnectorJsonAuditOrThrow(params.metadata, (key) => AUDIT_SECRET_KEY.test(key)),
          createdAt: millis(params.createdAt) ?? Date.now(),
        };
        this.insert("connector_audit", record.id, record.createdAt, record);
        return record;
      }));
  }

  private flowId(flow: OAuthFlowRecord): string {
    return list([flow.agentId, flow.provider, flow.stateHash]);
  }

  private findFlow(params: GetOAuthFlowStateParams): OAuthFlowRecord | null {
    const stateHash = params.stateHash ?? (params.state ? sha256(params.state) : undefined);
    const select = (where: string, value: string) =>
      this.select<OAuthFlowRecord>(
        "oauth_flows",
        `${where} = ? AND json_extract(body, '$.agentId') = ? AND (? IS NULL OR json_extract(body, '$.provider') = ?)`,
        [value, params.agentId ?? this.agentId(), params.provider ?? null, params.provider ?? null],
      )[0];
    const flow = (stateHash ? select("json_extract(body, '$.stateHash')", stateHash) : undefined)
      ?? (params.flowId ? select("json_extract(body, '$.metadata.flowId')", params.flowId) : undefined);
    if (!flow) return null;
    const now = millis(params.now) ?? Date.now();
    if (!params.includeConsumed && flow.consumedAt != null) return null;
    if (!params.includeExpired && flow.expiresAt <= now) return null;
    return flow;
  }

  override createOAuthFlowState(params: CreateOAuthFlowStateParams): Promise<OAuthFlowRecord> {
    return this.run("createOAuthFlowState", () =>
      this.atomic(() => {
        const now = Date.now();
        const flow: OAuthFlowRecord = {
          stateHash: sha256(params.state),
          agentId: params.agentId ?? this.agentId(),
          provider: params.provider,
          accountId: params.accountId ?? null,
          redirectUri: params.redirectUri ?? null,
          codeVerifierRef: params.codeVerifierRef ?? null,
          scopes: [...(params.scopes ?? [])],
          metadata: cloneConnectorJsonObjectOrThrow(params.metadata),
          createdAt: now,
          expiresAt: millis(params.expiresAt) ?? now + (params.ttlMs ?? 10 * 60_000),
          consumedAt: null,
          consumedBy: null,
        };
        const existing = this.row("oauth_flows", this.flowId(flow));
        if (existing) flow.createdAt = parse<OAuthFlowRecord>(existing).createdAt;
        this.put("oauth_flows", this.flowId(flow), flow.createdAt, flow);
        return flow;
      }));
  }

  override consumeOAuthFlowState(params: ConsumeOAuthFlowStateParams): Promise<OAuthFlowRecord | null> {
    return this.run("consumeOAuthFlowState", () =>
      this.atomic(() => {
        const now = millis(params.now) ?? Date.now();
        const flow = this.findFlow({ ...params, now });
        if (!flow) return null;
        const consumed: OAuthFlowRecord = { ...flow, consumedAt: now, consumedBy: params.consumedBy ?? null };
        const stored = this.row("oauth_flows", this.flowId(flow));
        return stored && this.replace("oauth_flows", stored.id, consumed, stored.revision) ? consumed : null;
      }));
  }

  override getOAuthFlowState(params: GetOAuthFlowStateParams): Promise<OAuthFlowRecord | null> {
    return this.run("getOAuthFlowState", () => this.findFlow(params));
  }

  override updateOAuthFlowState(params: UpdateOAuthFlowStateParams): Promise<OAuthFlowRecord | null> {
    return this.run("updateOAuthFlowState", () =>
      this.atomic(() => {
        const flow = this.findFlow({ ...params, includeConsumed: true, includeExpired: true });
        if (!flow) return null;
        const updated: OAuthFlowRecord = {
          ...flow,
          accountId: params.accountId !== undefined ? params.accountId : flow.accountId,
          redirectUri: params.redirectUri !== undefined ? params.redirectUri : flow.redirectUri,
          codeVerifierRef: params.codeVerifierRef !== undefined ? params.codeVerifierRef : flow.codeVerifierRef,
          scopes: [...(params.scopes ?? flow.scopes)],
          metadata: { ...flow.metadata, ...cloneConnectorJsonObjectOrThrow(params.metadata) },
          expiresAt: millis(params.expiresAt) ?? flow.expiresAt,
          consumedAt: params.consumedAt !== undefined ? millis(params.consumedAt) : flow.consumedAt,
          consumedBy: params.consumedBy !== undefined ? params.consumedBy : flow.consumedBy,
        };
        this.replace("oauth_flows", this.flowId(flow), updated);
        return updated;
      }));
  }

  override deleteOAuthFlowState(params: DeleteOAuthFlowStateParams): Promise<boolean> {
    return this.run("deleteOAuthFlowState", () => {
      const flow = this.findFlow({ ...params, includeConsumed: true, includeExpired: true });
      return flow ? this.remove("oauth_flows", [this.flowId(flow)]) > 0 : false;
    });
  }
}
