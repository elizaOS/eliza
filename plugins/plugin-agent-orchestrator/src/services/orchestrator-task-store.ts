/**
 * Durable orchestrator task store.
 *
 * Persists one {@link OrchestratorTaskDocument} per task across three
 * backends, picked in the same order as the ACP session store: a runtime SQL
 * adapter when present, else a JSON file, else memory. The document model
 * keeps each task's sessions / events / messages / usage / artifacts /
 * decisions inline so a detail read is a single lookup.
 *
 * @module services/orchestrator-task-store
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CreateTaskInput,
  OrchestratorTaskArtifact,
  OrchestratorTaskDecision,
  OrchestratorTaskDocument,
  OrchestratorTaskEvent,
  OrchestratorTaskMessage,
  OrchestratorTaskPlanRevision,
  OrchestratorTaskRecord,
  OrchestratorTaskSession,
  OrchestratorTaskUsage,
  TaskListFilter,
} from "./orchestrator-task-types.js";

export type TaskStoreBackend = "runtime-db" | "file" | "memory";

interface Logger {
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
}

interface TaskStoreRuntime {
  databaseAdapter?: unknown;
  logger?: Logger;
  getSetting?: (key: string) => string | undefined;
}

type SqlDatabaseAdapter = {
  query?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  execute?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  run?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  all?: (sql: string, params?: unknown[]) => Promise<unknown[]> | unknown[];
  get?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  select?: (sql: string, params?: unknown[]) => Promise<unknown[]> | unknown[];
};

// Bound auxiliary inline collections so telemetry/artifact chatter cannot grow
// without limit. The primary operator timeline (messages + events) remains
// uncapped so inspection and recovery can page all retained task history.
const MAX_USAGE = 1000;
const MAX_DECISIONS = 300;
const MAX_ARTIFACTS = 200;

const FILE_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const FILE_LOCK_STALE_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Boundary guard for documents loaded from disk/JSON. A document must carry a
 * task with an id plus the inline child arrays that existed before the
 * plan-revision rollout. `planRevisions` is filled below for older documents. */
function normalizeTaskDocument(
  value: unknown,
): OrchestratorTaskDocument | null {
  if (!isRecord(value)) return null;
  const task = value.task;
  if (!isRecord(task) || typeof task.id !== "string") return null;
  const hasRequiredChildren =
    Array.isArray(value.sessions) &&
    Array.isArray(value.events) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.usage) &&
    Array.isArray(value.artifacts) &&
    Array.isArray(value.decisions);
  if (!hasRequiredChildren) return null;
  return {
    ...(value as unknown as OrchestratorTaskDocument),
    planRevisions: Array.isArray(value.planRevisions)
      ? (value.planRevisions as OrchestratorTaskPlanRevision[])
      : [],
  };
}

function isSqlDatabaseAdapter(value: unknown): value is SqlDatabaseAdapter {
  if (!isRecord(value)) return false;
  return ["query", "execute", "run", "all", "get", "select"].some(
    (method) => typeof value[method] === "function",
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampTail<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

function buildSearchText(doc: OrchestratorTaskDocument): string {
  const t = doc.task;
  return [
    t.title,
    t.goal,
    t.originalRequest,
    t.summary ?? "",
    ...t.acceptanceCriteria,
    ...doc.sessions.map((s) => `${s.label} ${s.framework} ${s.workdir}`),
  ]
    .join(" ")
    .toLowerCase();
}

function newTaskDocument(input: CreateTaskInput): OrchestratorTaskDocument {
  const ts = nowIso();
  const task: OrchestratorTaskRecord = {
    id: randomUUID(),
    title: input.title.trim() || "Untitled task",
    goal: input.goal.trim() || input.title.trim(),
    kind: input.kind ?? "task",
    status: "open",
    priority: input.priority ?? "normal",
    originalRequest: input.originalRequest ?? input.goal ?? input.title,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    currentPlan: input.currentPlan,
    ownerUserId: input.ownerUserId,
    worldId: input.worldId,
    roomId: input.roomId,
    taskRoomId: input.taskRoomId,
    parentTaskId: input.parentTaskId,
    forkSource: input.forkSource,
    providerPolicy: input.providerPolicy,
    paused: false,
    archived: false,
    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: Date.now(),
    metadata: input.metadata ?? {},
  };
  return {
    task,
    sessions: [],
    events: [],
    messages: [],
    usage: [],
    artifacts: [],
    decisions: [],
    planRevisions: [],
  };
}

function cloneDocument(
  doc: OrchestratorTaskDocument,
): OrchestratorTaskDocument {
  return structuredClone({ ...doc, planRevisions: doc.planRevisions ?? [] });
}

function omitUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined,
    ),
  ) as Partial<T>;
}

function matchesFilter(
  task: OrchestratorTaskRecord,
  filter: TaskListFilter,
  searchText: string,
): boolean {
  if (!filter.includeArchived && task.archived) return false;
  if (filter.status && filter.status !== "all" && task.status !== filter.status)
    return false;
  if (filter.search) {
    const needle = filter.search.trim().toLowerCase();
    if (needle && !searchText.includes(needle)) return false;
  }
  return true;
}

/**
 * In-memory backend. The file backend extends this with JSON persistence; the
 * SQL backend reimplements the same surface against a runtime adapter.
 */
export class InMemoryTaskStore {
  protected readonly docs = new Map<string, OrchestratorTaskDocument>();
  private tail = Promise.resolve();

  protected enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async createTask(input: CreateTaskInput): Promise<OrchestratorTaskDocument> {
    return this.enqueue(async () => {
      const doc = newTaskDocument(input);
      this.docs.set(doc.task.id, doc);
      await this.afterWrite();
      return cloneDocument(doc);
    });
  }

  async getTask(id: string): Promise<OrchestratorTaskDocument | null> {
    const doc = this.docs.get(id);
    return doc ? cloneDocument(doc) : null;
  }

  async listTasks(
    filter: TaskListFilter = {},
  ): Promise<OrchestratorTaskRecord[]> {
    const matches = [...this.docs.values()]
      .filter((doc) => matchesFilter(doc.task, filter, buildSearchText(doc)))
      .map((doc) => doc.task)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const limited =
      filter.limit && filter.limit > 0
        ? matches.slice(0, filter.limit)
        : matches;
    return limited.map((t) => structuredClone(t));
  }

  async updateTask(
    id: string,
    patch: Partial<OrchestratorTaskRecord>,
  ): Promise<OrchestratorTaskRecord | null> {
    return this.enqueue(async () => {
      const doc = this.docs.get(id);
      if (!doc) return null;
      const nextPatch = structuredClone(omitUndefined(patch));
      doc.task = {
        ...doc.task,
        ...nextPatch,
        id: doc.task.id,
        createdAt: doc.task.createdAt,
        updatedAt: nowIso(),
        lastActivityAt: nextPatch.lastActivityAt ?? Date.now(),
      };
      await this.afterWrite();
      return structuredClone(doc.task);
    });
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const existed = this.docs.delete(id);
      if (existed) await this.afterWrite();
      return existed;
    });
  }

  async addSession(session: OrchestratorTaskSession): Promise<void> {
    await this.enqueue(async () => {
      const doc = this.docs.get(session.taskId);
      if (!doc) return;
      const idx = doc.sessions.findIndex(
        (s) => s.sessionId === session.sessionId,
      );
      if (idx >= 0) doc.sessions[idx] = session;
      else doc.sessions.push(session);
      doc.task.lastActivityAt = Date.now();
      doc.task.updatedAt = nowIso();
      await this.afterWrite();
    });
  }

  async updateSession(
    sessionId: string,
    patch: Partial<OrchestratorTaskSession>,
  ): Promise<void> {
    await this.enqueue(async () => {
      for (const doc of this.docs.values()) {
        const session = doc.sessions.find((s) => s.sessionId === sessionId);
        if (!session) continue;
        Object.assign(session, patch, {
          sessionId: session.sessionId,
          taskId: session.taskId,
          updatedAt: nowIso(),
        });
        doc.task.lastActivityAt = Date.now();
        doc.task.updatedAt = nowIso();
        await this.afterWrite();
        return;
      }
    });
  }

  async findSession(
    sessionId: string,
  ): Promise<{ taskId: string; session: OrchestratorTaskSession } | null> {
    for (const doc of this.docs.values()) {
      const session = doc.sessions.find((s) => s.sessionId === sessionId);
      if (session)
        return { taskId: doc.task.id, session: structuredClone(session) };
    }
    return null;
  }

  async addEvent(event: OrchestratorTaskEvent): Promise<void> {
    await this.appendChild(event.taskId, (doc) => {
      doc.events.push(event);
    });
  }

  async addMessage(message: OrchestratorTaskMessage): Promise<void> {
    await this.appendChild(message.taskId, (doc) => {
      doc.messages.push(message);
    });
  }

  async addUsage(usage: OrchestratorTaskUsage): Promise<void> {
    await this.appendChild(usage.taskId, (doc) => {
      doc.usage.push(usage);
      doc.usage = clampTail(doc.usage, MAX_USAGE);
    });
  }

  async addArtifact(artifact: OrchestratorTaskArtifact): Promise<void> {
    await this.appendChild(artifact.taskId, (doc) => {
      doc.artifacts.push(artifact);
      doc.artifacts = clampTail(doc.artifacts, MAX_ARTIFACTS);
    });
  }

  async addDecision(decision: OrchestratorTaskDecision): Promise<void> {
    await this.appendChild(decision.taskId, (doc) => {
      doc.decisions.push(decision);
      doc.decisions = clampTail(doc.decisions, MAX_DECISIONS);
    });
  }

  async addPlanRevision(revision: OrchestratorTaskPlanRevision): Promise<void> {
    await this.appendChild(revision.taskId, (doc) => {
      const stored = structuredClone(revision);
      const idx = doc.planRevisions.findIndex(
        (item) => item.id === revision.id,
      );
      if (idx >= 0) doc.planRevisions[idx] = stored;
      else doc.planRevisions.push(stored);
    });
  }

  private async appendChild(
    taskId: string,
    mutate: (doc: OrchestratorTaskDocument) => void,
  ): Promise<void> {
    await this.enqueue(async () => {
      const doc = this.docs.get(taskId);
      if (!doc) return;
      mutate(doc);
      doc.task.lastActivityAt = Date.now();
      doc.task.updatedAt = nowIso();
      await this.afterWrite();
    });
  }

  protected async afterWrite(): Promise<void> {
    // Durable subclasses persist here.
  }

  /** Replace the in-memory doc set from a durable source. Public so the SQL
   * backend can seed this store as a single-document mutation engine. */
  hydrate(docs: OrchestratorTaskDocument[]): void {
    this.docs.clear();
    for (const doc of docs) this.docs.set(doc.task.id, doc);
  }
}

function defaultStateFile(runtime?: TaskStoreRuntime): string {
  const configured =
    process.env.ELIZA_ACP_STATE_DIR ??
    runtime?.getSetting?.("ELIZA_ACP_STATE_DIR");
  const base = configured ?? join(homedir(), ".eliza", "plugin-acp");
  return join(base, "orchestrator-tasks.json");
}

export class FileTaskStore extends InMemoryTaskStore {
  private readonly lockFile: string;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly logger?: Logger,
  ) {
    super();
    this.lockFile = `${filePath}.lock`;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as unknown;
      if (Array.isArray(parsed)) {
        this.hydrate(
          parsed
            .map(normalizeTaskDocument)
            .filter((doc): doc is OrchestratorTaskDocument => doc !== null),
        );
      }
    } catch (error) {
      const code =
        isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT") {
        this.logger?.warn?.(
          "[OrchestratorTaskStore] task file unreadable; starting empty",
          error,
        );
      }
    }
    this.loaded = true;
  }

  override async createTask(input: CreateTaskInput) {
    await this.ensureLoaded();
    return super.createTask(input);
  }
  override async getTask(id: string) {
    await this.ensureLoaded();
    return super.getTask(id);
  }
  override async listTasks(filter?: TaskListFilter) {
    await this.ensureLoaded();
    return super.listTasks(filter);
  }
  override async updateTask(
    id: string,
    patch: Partial<OrchestratorTaskRecord>,
  ) {
    await this.ensureLoaded();
    return super.updateTask(id, patch);
  }
  override async deleteTask(id: string) {
    await this.ensureLoaded();
    return super.deleteTask(id);
  }
  override async addSession(session: OrchestratorTaskSession) {
    await this.ensureLoaded();
    return super.addSession(session);
  }
  override async updateSession(
    sessionId: string,
    patch: Partial<OrchestratorTaskSession>,
  ) {
    await this.ensureLoaded();
    return super.updateSession(sessionId, patch);
  }
  override async findSession(sessionId: string) {
    await this.ensureLoaded();
    return super.findSession(sessionId);
  }
  override async addEvent(event: OrchestratorTaskEvent) {
    await this.ensureLoaded();
    return super.addEvent(event);
  }
  override async addMessage(message: OrchestratorTaskMessage) {
    await this.ensureLoaded();
    return super.addMessage(message);
  }
  override async addUsage(usage: OrchestratorTaskUsage) {
    await this.ensureLoaded();
    return super.addUsage(usage);
  }
  override async addArtifact(artifact: OrchestratorTaskArtifact) {
    await this.ensureLoaded();
    return super.addArtifact(artifact);
  }
  override async addDecision(decision: OrchestratorTaskDecision) {
    await this.ensureLoaded();
    return super.addDecision(decision);
  }
  override async addPlanRevision(revision: OrchestratorTaskPlanRevision) {
    await this.ensureLoaded();
    return super.addPlanRevision(revision);
  }

  protected override async afterWrite(): Promise<void> {
    await this.withLock(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const payload = JSON.stringify([...this.docs.values()], null, 2);
      await writeFile(tempPath, `${payload}\n`, "utf8");
      await rename(tempPath, this.filePath);
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + FILE_LOCK_ACQUIRE_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      let pending: Awaited<ReturnType<typeof open>> | undefined;
      try {
        pending = await open(this.lockFile, "wx");
        await pending.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
        handle = pending;
      } catch (error) {
        if (pending) {
          await pending.close().catch(() => {});
          await rm(this.lockFile, { force: true }).catch(() => {});
        }
        const code =
          isRecord(error) && typeof error.code === "string" ? error.code : "";
        if (code !== "EEXIST" || Date.now() > deadline) throw error;
        await this.removeStaleLock();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await rm(this.lockFile, { force: true });
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const info = await stat(this.lockFile);
      if (Date.now() - info.mtimeMs < FILE_LOCK_STALE_MS) return;
      await rm(this.lockFile, { force: true });
    } catch (error) {
      const code =
        isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT") throw error;
    }
  }
}

const TASK_TABLE_SQL = `CREATE TABLE IF NOT EXISTS orchestrator_tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  priority TEXT,
  title TEXT,
  search_text TEXT,
  updated_at TEXT NOT NULL,
  last_activity_at INTEGER NOT NULL,
  document TEXT NOT NULL
)`;

const TASK_INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_orch_tasks_status ON orchestrator_tasks(status)",
  "CREATE INDEX IF NOT EXISTS idx_orch_tasks_activity ON orchestrator_tasks(last_activity_at)",
];

/** SQL backend. Stores the whole document as a JSON column with indexed
 * columns for the list query, so all reads/writes are single-row operations. */
export class RuntimeDbTaskStore {
  private readonly cache = new InMemoryTaskStore();
  private initPromise: Promise<void> | undefined;
  private tail = Promise.resolve();

  constructor(private readonly adapter: SqlDatabaseAdapter) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureInitialized(): Promise<void> {
    this.initPromise ??= (async () => {
      await this.exec(TASK_TABLE_SQL);
      for (const sql of TASK_INDEX_SQL) await this.exec(sql);
    })();
    await this.initPromise;
  }

  private async exec(sql: string, params: unknown[] = []): Promise<unknown> {
    const fn = this.adapter.execute ?? this.adapter.run ?? this.adapter.query;
    if (!fn)
      throw new Error("Runtime DB adapter exposes none of execute/run/query");
    return fn.call(this.adapter, sql, params);
  }

  private async rows(sql: string, params: unknown[] = []): Promise<unknown[]> {
    const fn = this.adapter.all ?? this.adapter.select ?? this.adapter.query;
    if (!fn)
      throw new Error("Runtime DB adapter exposes none of all/select/query");
    const result = await fn.call(this.adapter, sql, params);
    if (Array.isArray(result)) return result;
    if (isRecord(result)) {
      for (const key of ["rows", "results", "data", "values"]) {
        if (Array.isArray(result[key])) return result[key] as unknown[];
      }
    }
    return [];
  }

  private parseDoc(row: unknown): OrchestratorTaskDocument | null {
    if (!isRecord(row) || typeof row.document !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(row.document);
      return normalizeTaskDocument(parsed);
    } catch {
      return null;
    }
  }

  private async persist(doc: OrchestratorTaskDocument): Promise<void> {
    const searchText = buildSearchText(doc);
    await this.exec(
      `INSERT OR REPLACE INTO orchestrator_tasks
       (id, status, archived, priority, title, search_text, updated_at, last_activity_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        doc.task.id,
        doc.task.status,
        doc.task.archived ? 1 : 0,
        doc.task.priority,
        doc.task.title,
        searchText,
        doc.task.updatedAt,
        doc.task.lastActivityAt,
        JSON.stringify(doc),
      ],
    );
  }

  private async loadOne(id: string): Promise<OrchestratorTaskDocument | null> {
    const rows = await this.rows(
      "SELECT document FROM orchestrator_tasks WHERE id = ?",
      [id],
    );
    return rows.length > 0 ? this.parseDoc(rows[0]) : null;
  }

  async createTask(input: CreateTaskInput): Promise<OrchestratorTaskDocument> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const doc = await this.cache.createTask(input);
      await this.persist(doc);
      return doc;
    });
  }

  async getTask(id: string): Promise<OrchestratorTaskDocument | null> {
    await this.ensureInitialized();
    return this.loadOne(id);
  }

  async listTasks(
    filter: TaskListFilter = {},
  ): Promise<OrchestratorTaskRecord[]> {
    await this.ensureInitialized();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeArchived) clauses.push("archived = 0");
    if (filter.status && filter.status !== "all") {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.search?.trim()) {
      clauses.push("search_text LIKE ?");
      params.push(`%${filter.search.trim().toLowerCase()}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit =
      filter.limit && filter.limit > 0
        ? `LIMIT ${Math.floor(filter.limit)}`
        : "";
    const rows = await this.rows(
      `SELECT document FROM orchestrator_tasks ${where} ORDER BY last_activity_at DESC ${limit}`,
      params,
    );
    return rows
      .map((row) => this.parseDoc(row)?.task)
      .filter((t): t is OrchestratorTaskRecord => Boolean(t));
  }

  /** Run a mutation against the freshest stored document, then persist it. */
  private async mutate<T>(
    id: string,
    op: (cache: InMemoryTaskStore) => Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const current = await this.loadOne(id);
      this.cache.hydrate(current ? [current] : []);
      const result = await op(this.cache);
      const next = await this.cache.getTask(id);
      if (next) await this.persist(next);
      return result;
    });
  }

  async updateTask(id: string, patch: Partial<OrchestratorTaskRecord>) {
    return this.mutate(id, (c) => c.updateTask(id, patch));
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      await this.exec("DELETE FROM orchestrator_tasks WHERE id = ?", [id]);
      return true;
    });
  }

  async addSession(session: OrchestratorTaskSession) {
    return this.mutate(session.taskId, (c) => c.addSession(session));
  }

  async updateSession(
    sessionId: string,
    patch: Partial<OrchestratorTaskSession>,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const found = await this.findSession(sessionId);
      if (!found) return;
      const current = await this.loadOne(found.taskId);
      this.cache.hydrate(current ? [current] : []);
      await this.cache.updateSession(sessionId, patch);
      const next = await this.cache.getTask(found.taskId);
      if (next) await this.persist(next);
    });
  }

  async findSession(sessionId: string) {
    await this.ensureInitialized();
    const rows = await this.rows(
      "SELECT document FROM orchestrator_tasks WHERE document LIKE ?",
      [`%${sessionId}%`],
    );
    for (const row of rows) {
      const doc = this.parseDoc(row);
      const session = doc?.sessions.find((s) => s.sessionId === sessionId);
      if (doc && session) return { taskId: doc.task.id, session };
    }
    return null;
  }

  async addEvent(event: OrchestratorTaskEvent) {
    return this.mutate(event.taskId, (c) => c.addEvent(event));
  }
  async addMessage(message: OrchestratorTaskMessage) {
    return this.mutate(message.taskId, (c) => c.addMessage(message));
  }
  async addUsage(usage: OrchestratorTaskUsage) {
    return this.mutate(usage.taskId, (c) => c.addUsage(usage));
  }
  async addArtifact(artifact: OrchestratorTaskArtifact) {
    return this.mutate(artifact.taskId, (c) => c.addArtifact(artifact));
  }
  async addDecision(decision: OrchestratorTaskDecision) {
    return this.mutate(decision.taskId, (c) => c.addDecision(decision));
  }
  async addPlanRevision(revision: OrchestratorTaskPlanRevision) {
    return this.mutate(revision.taskId, (c) => c.addPlanRevision(revision));
  }
}

export interface OrchestratorTaskStoreOptions {
  runtime?: TaskStoreRuntime;
  stateFile?: string;
  backend?: TaskStoreBackend;
}

/** Backend-selecting facade. Mirrors `AcpSessionStore`'s selection order. */
export class OrchestratorTaskStore {
  readonly backend: TaskStoreBackend;
  private readonly delegate: InMemoryTaskStore | RuntimeDbTaskStore;

  constructor(options: OrchestratorTaskStoreOptions = {}) {
    const adapter = options.runtime?.databaseAdapter;
    const logger = options.runtime?.logger;
    if (
      (options.backend === undefined || options.backend === "runtime-db") &&
      isSqlDatabaseAdapter(adapter)
    ) {
      this.backend = "runtime-db";
      this.delegate = new RuntimeDbTaskStore(adapter);
      return;
    }
    if (options.backend === "memory") {
      this.backend = "memory";
      this.delegate = new InMemoryTaskStore();
      return;
    }
    this.backend = "file";
    this.delegate = new FileTaskStore(
      options.stateFile ?? defaultStateFile(options.runtime),
      logger,
    );
  }

  createTask(input: CreateTaskInput) {
    return this.delegate.createTask(input);
  }
  getTask(id: string) {
    return this.delegate.getTask(id);
  }
  listTasks(filter?: TaskListFilter) {
    return this.delegate.listTasks(filter);
  }
  updateTask(id: string, patch: Partial<OrchestratorTaskRecord>) {
    return this.delegate.updateTask(id, patch);
  }
  deleteTask(id: string) {
    return this.delegate.deleteTask(id);
  }
  addSession(session: OrchestratorTaskSession) {
    return this.delegate.addSession(session);
  }
  updateSession(sessionId: string, patch: Partial<OrchestratorTaskSession>) {
    return this.delegate.updateSession(sessionId, patch);
  }
  findSession(sessionId: string) {
    return this.delegate.findSession(sessionId);
  }
  addEvent(event: OrchestratorTaskEvent) {
    return this.delegate.addEvent(event);
  }
  addMessage(message: OrchestratorTaskMessage) {
    return this.delegate.addMessage(message);
  }
  addUsage(usage: OrchestratorTaskUsage) {
    return this.delegate.addUsage(usage);
  }
  addArtifact(artifact: OrchestratorTaskArtifact) {
    return this.delegate.addArtifact(artifact);
  }
  addDecision(decision: OrchestratorTaskDecision) {
    return this.delegate.addDecision(decision);
  }
  addPlanRevision(revision: OrchestratorTaskPlanRevision) {
    return this.delegate.addPlanRevision(revision);
  }
}
