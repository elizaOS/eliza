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
  /** Modern eliza runtime exposes the DB adapter as `runtime.adapter`. */
  adapter?: unknown;
  /** Legacy alias kept for pre-2026 runtimes and custom container harnesses. */
  databaseAdapter?: unknown;
  logger?: Logger;
  getSetting?: (key: string) => string | undefined;
}

/** Raw shape: an adapter that exposes flat SQL methods directly. Older test
 * harnesses (and hand-rolled sqlite bindings) look like this. */
type RawSqlDatabaseAdapter = {
  query?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  execute?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  run?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  all?: (sql: string, params?: unknown[]) => Promise<unknown[]> | unknown[];
  get?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  select?: (sql: string, params?: unknown[]) => Promise<unknown[]> | unknown[];
};

/** Eliza shape: `BaseDrizzleAdapter` from @elizaos/plugin-sql. The raw
 * executor lives on `adapter.db.execute(sql\`...\`)` (drizzle's tagged-template
 * SQL). We only need `.execute` here. It returns a rowset for SELECTs and an
 * ack for writes, which is all this store's storage-layer touches. */
type ElizaDrizzleAdapter = {
  db: {
    execute: (query: unknown) => Promise<unknown> | unknown;
  };
};

/** Unified low-level executor. `run` performs a mutation and ignores the
 * result; `all` runs a SELECT and returns rows. */
interface SqlExecutor {
  run(sql: string, params?: unknown[]): Promise<void>;
  all(sql: string, params?: unknown[]): Promise<unknown[]>;
}

// Bound auxiliary inline collections so telemetry/artifact chatter cannot grow
// without limit. The primary operator timeline (messages + events) remains
// uncapped so inspection and recovery can page all retained task history.
const MAX_USAGE = 1000;
const MAX_DECISIONS = 300;
const MAX_ARTIFACTS = 200;

// How long a waiter keeps trying to acquire the lock before giving up.
const FILE_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
// A lock is only reclaimed as "stale" once it is older than this. It MUST be
// shorter than the acquire timeout (so a waiter can reclaim a dead lock within
// its own wait window) yet far longer than a legitimate hold — the guarded work
// is a single atomic scratch-file write + rename, sub-second even for large task
// histories, so a lock older than 10s means the holder died mid-write. Setting
// this equal to the acquire timeout (the previous value) let a waiter give up at
// the exact moment a lock became reclaimable, and risked reclaiming a lock still
// held by a slow-but-alive writer.
const FILE_LOCK_STALE_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDuplicateColumnError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === "42701") return true;
  const message =
    typeof error.message === "string" ? error.message.toLowerCase() : "";
  return (
    message.includes("duplicate column") ||
    /column .+ already exists/.test(message)
  );
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

function isRawSqlDatabaseAdapter(
  value: unknown,
): value is RawSqlDatabaseAdapter {
  if (!isRecord(value)) return false;
  return ["query", "execute", "run", "all", "get", "select"].some(
    (method) => typeof value[method] === "function",
  );
}

function isElizaDrizzleAdapter(value: unknown): value is ElizaDrizzleAdapter {
  if (!isRecord(value)) return false;
  const db = value.db;
  return isRecord(db) && typeof db.execute === "function";
}

function isPersistableAdapter(
  value: unknown,
): value is RawSqlDatabaseAdapter | ElizaDrizzleAdapter {
  return isRawSqlDatabaseAdapter(value) || isElizaDrizzleAdapter(value);
}

/**
 * Resolve a raw or eliza-shaped adapter to a unified `SqlExecutor`.
 *
 * For raw adapters we pick the best available method for each operation.
 * For eliza adapters we bake a tiny drizzle-flavored parameter binder: the
 * SQL we emit uses `?` placeholders, so we substitute drizzle's own
 * `sql\`...\`` template that concatenates literal string segments with
 * `sql.param(value)` bind markers, using the drizzle runtime already loaded
 * next to the adapter. Since we only invoke this from within an environment
 * that ships `@elizaos/plugin-sql` (drizzle-orm is present), we require it
 * lazily at first use to avoid a hard dependency here.
 */
async function resolveSqlExecutor(
  adapter: RawSqlDatabaseAdapter | ElizaDrizzleAdapter,
): Promise<SqlExecutor> {
  if (isElizaDrizzleAdapter(adapter)) {
    // Lazily require drizzle's sql builder. Cast through unknown, since the
    // eliza adapter guarantees drizzle-orm is installed alongside it.
    const drizzle = (await import("drizzle-orm")) as {
      sql: {
        raw(text: string): unknown;
        param(value: unknown): unknown;
        join(chunks: unknown[], separator?: unknown): unknown;
      };
    };
    const buildQuery = (text: string, params: unknown[] = []): unknown => {
      if (params.length === 0) return drizzle.sql.raw(text);
      // Split the emitted SQL on `?` placeholders and interleave drizzle
      // bind-param chunks between the literal fragments. We only ever emit
      // `?` (never `?N`) below, so a naive split is safe here.
      const parts = text.split("?");
      if (parts.length - 1 !== params.length) {
        throw new Error(
          `orchestrator-task-store: placeholder/param count mismatch (${
            parts.length - 1
          } placeholders vs ${params.length} params)`,
        );
      }
      const chunks: unknown[] = [];
      for (let i = 0; i < parts.length; i++) {
        chunks.push(drizzle.sql.raw(parts[i]));
        if (i < params.length) chunks.push(drizzle.sql.param(params[i]));
      }
      return drizzle.sql.join(chunks);
    };
    return {
      async run(text, params) {
        await adapter.db.execute(buildQuery(text, params));
      },
      async all(text, params) {
        const result = await adapter.db.execute(buildQuery(text, params));
        return normalizeRowset(result);
      },
    };
  }

  const runFn = adapter.execute ?? adapter.run ?? adapter.query;
  const allFn = adapter.all ?? adapter.select ?? adapter.query;
  if (!runFn) {
    throw new Error(
      "orchestrator-task-store: raw adapter exposes none of execute/run/query",
    );
  }
  if (!allFn) {
    throw new Error(
      "orchestrator-task-store: raw adapter exposes none of all/select/query",
    );
  }
  return {
    async run(text, params = []) {
      await runFn.call(adapter, text, params);
    },
    async all(text, params = []) {
      const result = await allFn.call(adapter, text, params);
      return normalizeRowset(result);
    },
  };
}

function normalizeRowset(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (isRecord(result)) {
    for (const key of ["rows", "results", "data", "values"]) {
      if (Array.isArray(result[key])) return result[key] as unknown[];
    }
  }
  return [];
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
    // Session ids are included so `findSession` can prefilter on the indexed
    // `search_text` column instead of substring-scanning the whole JSON
    // `document` (which is both a full-table hot-path scan and the query that
    // fails on pglite — see RuntimeDbTaskStore.findSession, #11641).
    ...doc.sessions.map(
      (s) => `${s.label} ${s.framework} ${s.workdir} ${s.sessionId}`,
    ),
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
    projectId: input.projectId,
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
  if (filter.projectId && task.projectId !== filter.projectId) return false;
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
      this.noteMutated(doc.task.id);
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
      this.noteMutated(id);
      await this.afterWrite();
      return structuredClone(doc.task);
    });
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const existed = this.docs.delete(id);
      if (!existed) return false;
      // Record the delete inside the queued op, immediately before its own
      // afterWrite(). Recording it earlier (outside the queue) let an
      // already-queued write's afterWrite consume and clear the tombstone while
      // the doc was still present, after which the delete's own persist
      // re-seeded the doc from disk — resurrecting a task whose deleteTask had
      // returned true. It also left a lingering tombstone when the delete
      // turned out to be a no-op.
      this.noteDeleted(id);
      await this.afterWrite();
      return true;
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
      this.noteMutated(session.taskId);
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
        this.noteMutated(doc.task.id);
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
      this.noteMutated(taskId);
      await this.afterWrite();
    });
  }

  protected async afterWrite(): Promise<void> {
    // Durable subclasses persist here.
  }

  /** Called inside the queued op for every doc this store mutated, right
   * before afterWrite(). The file backend tracks these ids so its persist
   * only overlays docs this process actually changed. No-op here. */
  protected noteMutated(_id: string): void {}

  /** Called inside the queued op when a doc was actually removed, right
   * before afterWrite(). The file backend records a tombstone so its persist
   * does not resurrect the doc from a concurrent process's on-disk copy.
   * No-op here. */
  protected noteDeleted(_id: string): void {}

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
  // Ids this process deleted but has not yet durably persisted. afterWrite()
  // re-reads the on-disk document set under the lock; tombstones ensure a task
  // this process deleted is not resurrected from a concurrent process's copy
  // of the file. Populated via the noteDeleted() hook inside the queued delete
  // op so an earlier-queued write can never consume a tombstone prematurely.
  private readonly tombstones = new Set<string>();
  // Ids this process mutated but has not yet durably persisted. afterWrite()
  // overlays ONLY these docs onto the on-disk set, so tasks this process never
  // touched keep a concurrent process's (possibly newer) on-disk version
  // instead of being reverted to this process's stale in-memory copy.
  private readonly dirty = new Set<string>();

  constructor(
    private readonly filePath: string,
    private readonly logger?: Logger,
  ) {
    super();
    this.lockFile = `${filePath}.lock`;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.enqueue(async () => {
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
        } else {
          this.hydrate([]);
        }
      } catch (error) {
        // error-policy:J3 persisted-store load: ENOENT = no file yet, any other
        // read/parse error warns and starts empty (observable recovery).
        const code =
          isRecord(error) && typeof error.code === "string" ? error.code : "";
        if (code !== "ENOENT") {
          this.logger?.warn?.(
            "[OrchestratorTaskStore] task file unreadable; starting empty",
            error,
          );
        }
        this.hydrate([]);
      }
      this.loaded = true;
    });
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

  protected override noteMutated(id: string): void {
    this.dirty.add(id);
  }

  protected override noteDeleted(id: string): void {
    this.tombstones.add(id);
  }

  protected override async afterWrite(): Promise<void> {
    await this.withLock(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      // Read-merge-write under the lock so a concurrent process's writes to
      // OTHER tasks survive this process's write. Merge order:
      //   1. seed from the current on-disk set (concurrent inserts/updates),
      //   2. drop the ids this process deleted (tombstones),
      //   3. overlay only the docs this process actually mutated (dirty ids) —
      //      untouched tasks keep their on-disk versions.
      // Residual: two processes mutating the SAME task still resolve
      // last-writer-wins at the document level, matching the SQL backend's
      // single-row upsert semantics.
      const merged = new Map<string, OrchestratorTaskDocument>();
      try {
        const contents = await readFile(this.filePath, "utf8");
        const parsed = JSON.parse(contents) as unknown;
        if (Array.isArray(parsed)) {
          for (const raw of parsed) {
            const doc = normalizeTaskDocument(raw);
            if (doc) merged.set(doc.task.id, doc);
          }
        }
      } catch (error) {
        // error-policy:J3 persisted-merge read: ENOENT skipped, corrupt/unreadable
        // file warns and re-seeds the merge from in-memory state (observable).
        const code =
          isRecord(error) && typeof error.code === "string" ? error.code : "";
        if (code !== "ENOENT") {
          // A corrupt state file (e.g. a JSON.parse SyntaxError, which carries
          // no .code) must not brick every subsequent mutation — ensureLoaded
          // warns and continues for the same condition. The file is unreadable,
          // so the only surviving state is this process's in-memory doc set:
          // seed the merge from it (an empty seed would drop every non-dirty
          // task from memory AND the rewrite below). The atomic write then
          // replaces the corrupt file with a readable one.
          this.logger?.warn?.(
            "[OrchestratorTaskStore] task file unreadable during persist; rewriting from in-memory state",
            error,
          );
          for (const doc of this.docs.values()) merged.set(doc.task.id, doc);
        }
      }
      for (const id of this.tombstones) merged.delete(id);
      for (const id of this.dirty) {
        const doc = this.docs.get(id);
        if (doc) merged.set(id, doc);
      }
      // Adopt the merged view so subsequent reads in this process observe
      // concurrent inserts/updates/deletes too.
      this.docs.clear();
      for (const [id, doc] of merged) this.docs.set(id, doc);
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const payload = JSON.stringify([...merged.values()], null, 2);
      await writeFile(tempPath, `${payload}\n`, "utf8");
      await rename(tempPath, this.filePath);
      // Forget applied tombstones/dirty ids only after the rename lands; a
      // failed write leaves them pending so the next persist applies them.
      this.tombstones.clear();
      this.dirty.clear();
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
        // error-policy:J3 lock-acquire: EEXIST (lock held) is retried until the
        // deadline; every other error is rethrown below (fail-fast).
        if (pending) {
          // error-policy:J6 best-effort teardown — unwind a partial lock
          // acquire; the original acquire error below is authoritative and is
          // rethrown once retries are exhausted.
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
      // error-policy:J3 stale-lock stat: ENOENT = lock already gone (fine); any
      // other stat error is rethrown (fail-fast).
      const code =
        isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT") throw error;
    }
  }
}

// `last_activity_at` holds a Date.now() ms epoch (~1.75e12), which overflows
// postgres/pglite int4 — BIGINT is required there and maps to sqlite's 64-bit
// INTEGER affinity, so it is portable across every backend this store engages.
const TASK_TABLE_SQL = `CREATE TABLE IF NOT EXISTS orchestrator_tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  priority TEXT,
  title TEXT,
  project_id TEXT,
  search_text TEXT,
  updated_at TEXT NOT NULL,
  last_activity_at BIGINT NOT NULL,
  document TEXT NOT NULL
)`;

const TASK_INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_orch_tasks_status ON orchestrator_tasks(status)",
  "CREATE INDEX IF NOT EXISTS idx_orch_tasks_activity ON orchestrator_tasks(last_activity_at)",
  "CREATE INDEX IF NOT EXISTS idx_orch_tasks_project ON orchestrator_tasks(project_id)",
];

// Idempotent column backfill for tables created before `project_id` existed
// (#13776). `CREATE TABLE IF NOT EXISTS` never alters an existing table, so an
// upgraded runtime must ADD the column. No portable "IF NOT EXISTS" exists for
// ADD COLUMN across sqlite + postgres/pglite, so ensureInitialized runs this
// and treats an already-exists failure as a satisfied migration.
const TASK_MIGRATION_SQL = [
  "ALTER TABLE orchestrator_tasks ADD COLUMN project_id TEXT",
];

/** SQL backend. Stores the whole document as a JSON column with indexed
 * columns for the list query, so all reads/writes are single-row operations.
 *
 * Accepts either a raw sqlite-style adapter (older test harnesses,
 * hand-rolled bindings) or an eliza `BaseDrizzleAdapter` (postgres/pglite),
 * routing through {@link resolveSqlExecutor}. Upsert SQL uses `ON CONFLICT`
 * so it's portable across postgres, pglite, and sqlite ≥3.24. */
export class RuntimeDbTaskStore {
  private readonly cache = new InMemoryTaskStore();
  private initPromise: Promise<void> | undefined;
  private executor: SqlExecutor | undefined;
  private tail = Promise.resolve();

  constructor(
    private readonly adapter: RawSqlDatabaseAdapter | ElizaDrizzleAdapter,
  ) {}

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
      this.executor = await resolveSqlExecutor(this.adapter);
      await this.executor.run(TASK_TABLE_SQL);
      for (const sql of TASK_MIGRATION_SQL) {
        try {
          await this.executor.run(sql);
        } catch (err) {
          // error-policy:J6 idempotent DDL — ADD COLUMN throws on a table that
          // already has the column (every boot after the first); the desired
          // post-state is identical, so a duplicate-column failure is success.
          if (!isDuplicateColumnError(err)) throw err;
        }
      }
      for (const sql of TASK_INDEX_SQL) await this.executor.run(sql);
    })();
    await this.initPromise;
  }

  private exec(): SqlExecutor {
    if (!this.executor) {
      throw new Error(
        "orchestrator-task-store: executor accessed before ensureInitialized()",
      );
    }
    return this.executor;
  }

  private parseDoc(row: unknown): OrchestratorTaskDocument | null {
    if (!isRecord(row) || typeof row.document !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(row.document);
      return normalizeTaskDocument(parsed);
    } catch {
      // error-policy:J3 parse of a persisted task-document row; a corrupt row
      // yields an explicit "not a document" (null) so one bad row cannot crash
      // a list/scan, never a fabricated empty document.
      return null;
    }
  }

  private async persist(doc: OrchestratorTaskDocument): Promise<void> {
    const searchText = buildSearchText(doc);
    // Portable upsert. Postgres/pglite need ON CONFLICT DO UPDATE; sqlite
    // ≥3.24 accepts the same syntax. Named-column DO UPDATE avoids the
    // sqlite-only INSERT OR REPLACE form.
    await this.exec().run(
      `INSERT INTO orchestrator_tasks
       (id, status, archived, priority, title, project_id, search_text, updated_at, last_activity_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status,
         archived = excluded.archived,
         priority = excluded.priority,
         title = excluded.title,
         project_id = excluded.project_id,
         search_text = excluded.search_text,
         updated_at = excluded.updated_at,
         last_activity_at = excluded.last_activity_at,
         document = excluded.document`,
      [
        doc.task.id,
        doc.task.status,
        doc.task.archived ? 1 : 0,
        doc.task.priority,
        doc.task.title,
        doc.task.projectId ?? null,
        searchText,
        doc.task.updatedAt,
        doc.task.lastActivityAt,
        JSON.stringify(doc),
      ],
    );
  }

  private async loadOne(id: string): Promise<OrchestratorTaskDocument | null> {
    const rows = await this.exec().all(
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
    if (filter.projectId) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.search?.trim()) {
      clauses.push("search_text LIKE ?");
      params.push(`%${filter.search.trim().toLowerCase()}%`);
    }
    if (filter.projectId?.trim()) {
      clauses.push("project_id = ?");
      params.push(filter.projectId.trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit =
      filter.limit && filter.limit > 0
        ? `LIMIT ${Math.floor(filter.limit)}`
        : "";
    const rows = await this.exec().all(
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
      // The SqlExecutor.run contract returns void (no affected-row count that is
      // portable across the raw-sqlite and drizzle backends), so probe existence
      // first and report it faithfully. Returning an unconditional `true` (the
      // previous behavior) diverged from InMemoryTaskStore.deleteTask and made
      // the DELETE /tasks/:id route answer 200 for tasks that never existed.
      const existing = await this.loadOne(id);
      if (!existing) return false;
      await this.exec().run("DELETE FROM orchestrator_tasks WHERE id = ?", [
        id,
      ]);
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
    // Portable, targeted session-id lookup. The old `WHERE document LIKE ?`
    // used the serialized JSON `document` column as a text haystack, which:
    //   * fails outright on pglite/postgres — the drizzle/pglite driver does
    //     not treat that JSON-bearing column comparison as a plain-text `LIKE`
    //     the way sqlite does, so `SELECT document FROM orchestrator_tasks
    //     WHERE document LIKE $1` throws on every session event (#11641); and
    //   * scanned/serialized the ENTIRE document per event on the hot path.
    //
    // We instead prefilter on `search_text` — a plain, indexed TEXT column that
    // `listTasks` already matches with `LIKE` on every backend (sqlite/pglite/
    // postgres) without incident. `buildSearchText` now folds each session's
    // id into that column, so the DB narrows to candidate rows and we only
    // JSON-parse those. The authoritative decision is still the JS
    // `sessions.find(...)` below, so a substring false-positive can never
    // resolve to the wrong session.
    //
    // Both the prefilter AND the legacy fallback below use this one portable
    // `WHERE search_text LIKE ?` query shape (see #11778) — never a bare
    // full-table `SELECT document FROM orchestrator_tasks`, which pglite/
    // postgres reject.
    const needle = `%${sessionId.toLowerCase()}%`;
    const rows = await this.exec().all(
      "SELECT document FROM orchestrator_tasks WHERE search_text LIKE ?",
      [needle],
    );
    const match = this.matchSession(rows, sessionId);
    if (match) return match;
    // Legacy fallback: rows persisted before session ids were added to
    // `search_text` won't match the prefilter, so scan the rest. Two hardening
    // rules apply here, both learned from #11641/#11778:
    //
    //   1. Route the fallback through the SAME `WHERE search_text LIKE ?`
    //      query SHAPE the prefilter uses (an always-true `%` needle), rather
    //      than a bare `SELECT document FROM orchestrator_tasks`. The bare
    //      full-table select is the exact statement pglite/postgres rejected in
    //      #11778 (`Failed query: SELECT document FROM orchestrator_tasks
    //      params:`), in the same driver-quirk family as #11641's `document
    //      LIKE`. Reusing the proven-portable prefilter shape keeps every read
    //      on this method to one query form that all three backends accept.
    //
    //   2. Never let a fallback failure POISON the caller. `findSession` sits
    //      on the session-event hot path (`onSessionEvent → resolveTaskId →
    //      findSession`); if a driver quirk still throws here, the service
    //      suppresses ALL further event records for that session and the whole
    //      session's orchestration telemetry is silently lost (#11778's live
    //      symptom). A missed lookup is a clean `null`, not an exception, so a
    //      degraded fallback degrades to "session not found yet" instead of
    //      killing recording. The authoritative decision is still the JS
    //      `sessions.find(...)` in `matchSession`.
    try {
      const fallbackRows = await this.exec().all(
        "SELECT document FROM orchestrator_tasks WHERE search_text LIKE ?",
        ["%"],
      );
      return this.matchSession(fallbackRows, sessionId);
    } catch {
      // error-policy:J4 designed degrade — see the rationale above (#11778): on
      // the session-event hot path a fallback-query failure must degrade to
      // "session not found yet" (null), never poison the caller and silently
      // drop all further telemetry for the session.
      return null;
    }
  }

  private matchSession(rows: unknown[], sessionId: string) {
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
    // Prefer the modern `runtime.adapter` property (see
    // packages/core/src/runtime.ts declares `public adapter!: IDatabaseAdapter`);
    // fall back to the legacy `runtime.databaseAdapter` name that older test
    // harnesses and some custom container runtimes still use.
    const adapter =
      options.runtime?.adapter ?? options.runtime?.databaseAdapter;
    const logger = options.runtime?.logger;
    if (
      (options.backend === undefined || options.backend === "runtime-db") &&
      isPersistableAdapter(adapter)
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
