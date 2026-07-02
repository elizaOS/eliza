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
import {
  type SessionFilter,
  type SessionInfo,
  type SessionStatus,
  type SessionStore,
  type SessionStoreRuntime,
  TERMINAL_SESSION_STATUSES,
} from "./types.js";

export type SessionStoreBackend = "runtime-db" | "file" | "memory";

type Logger = NonNullable<SessionStoreRuntime["logger"]>;
const FILE_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const FILE_LOCK_STALE_MS = 30_000;

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

type StoredSession = Omit<SessionInfo, "createdAt" | "lastActivityAt"> & {
  createdAt: string;
  lastActivityAt: string;
};

const SESSION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS acp_sessions (
  id TEXT PRIMARY KEY,
  name TEXT,
  agent_type TEXT NOT NULL,
  workdir TEXT NOT NULL,
  status TEXT NOT NULL,
  acpx_record_id TEXT,
  acpx_session_id TEXT,
  agent_session_id TEXT,
  pid INTEGER,
  approval_preset TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_error TEXT,
  metadata TEXT
)`;

const SESSION_INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_acp_sessions_scope ON acp_sessions(workdir, agent_type, name)",
  "CREATE INDEX IF NOT EXISTS idx_acp_sessions_status ON acp_sessions(status)",
  "CREATE INDEX IF NOT EXISTS idx_acp_sessions_acpx_record_id ON acp_sessions(acpx_record_id)",
];

function cloneSession(session: SessionInfo): SessionInfo {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    lastActivityAt: new Date(session.lastActivityAt),
    metadata: session.metadata ? { ...session.metadata } : undefined,
  };
}

function toStoredSession(session: SessionInfo): StoredSession {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    metadata: session.metadata ? { ...session.metadata } : undefined,
  };
}

function fromStoredSession(session: StoredSession): SessionInfo {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    lastActivityAt: new Date(session.lastActivityAt),
    metadata: session.metadata ? { ...session.metadata } : undefined,
  };
}

function matchesFilter(session: SessionInfo, filter?: SessionFilter): boolean {
  if (!filter) return true;
  if (filter.status !== undefined && session.status !== filter.status)
    return false;
  if (
    filter.statuses !== undefined &&
    !filter.statuses.includes(session.status)
  )
    return false;
  if (filter.workdir !== undefined && session.workdir !== filter.workdir)
    return false;
  if (filter.agentType !== undefined && session.agentType !== filter.agentType)
    return false;
  if (filter.name !== undefined && session.name !== filter.name) return false;
  if (
    filter.acpxRecordId !== undefined &&
    session.acpxRecordId !== filter.acpxRecordId
  )
    return false;
  return true;
}

function defaultStateFile(): string {
  return join(homedir(), ".eliza", "plugin-acp", "sessions.json");
}

function resolveStateFile(
  runtime?: SessionStoreRuntime,
  stateFile?: string,
): string {
  if (stateFile) return stateFile;
  const configured =
    process.env.ELIZA_ACP_STATE_DIR ??
    runtime?.getSetting?.("ELIZA_ACP_STATE_DIR");
  return configured ? join(configured, "sessions.json") : defaultStateFile();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
          `acpx session-store: placeholder/param count mismatch (${
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
        return normalizeRows(result);
      },
    };
  }

  const runFn = adapter.execute ?? adapter.run ?? adapter.query;
  const allFn = adapter.all ?? adapter.select ?? adapter.query;
  if (!runFn) {
    throw new Error(
      "acpx session-store: raw adapter exposes none of execute/run/query",
    );
  }
  if (!allFn) {
    throw new Error(
      "acpx session-store: raw adapter exposes none of all/select/query",
    );
  }
  return {
    async run(text, params = []) {
      await runFn.call(adapter, text, params);
    },
    async all(text, params = []) {
      const result = await allFn.call(adapter, text, params);
      return normalizeRows(result);
    },
  };
}

function normalizeRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!isRecord(result)) return [];
  for (const key of ["rows", "results", "data", "values"]) {
    const value = result[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function rowToSession(row: unknown): SessionInfo {
  if (!isRecord(row)) throw new Error("Invalid session row");
  return {
    id: String(row.id),
    name:
      row.name === null || row.name === undefined
        ? undefined
        : String(row.name),
    agentType: String(row.agent_type),
    workdir: String(row.workdir),
    status: String(row.status),
    acpxRecordId:
      row.acpx_record_id === null || row.acpx_record_id === undefined
        ? undefined
        : String(row.acpx_record_id),
    acpxSessionId:
      row.acpx_session_id === null || row.acpx_session_id === undefined
        ? undefined
        : String(row.acpx_session_id),
    agentSessionId:
      row.agent_session_id === null || row.agent_session_id === undefined
        ? undefined
        : String(row.agent_session_id),
    pid:
      row.pid === null || row.pid === undefined ? undefined : Number(row.pid),
    approvalPreset: String(
      row.approval_preset,
    ) as SessionInfo["approvalPreset"],
    createdAt: new Date(String(row.created_at)),
    lastActivityAt: new Date(String(row.last_activity_at)),
    lastError:
      row.last_error === null || row.last_error === undefined
        ? undefined
        : String(row.last_error),
    metadata:
      typeof row.metadata === "string" && row.metadata.length > 0
        ? JSON.parse(row.metadata)
        : undefined,
  };
}

function sessionToParams(session: SessionInfo): unknown[] {
  return [
    session.id,
    session.name ?? null,
    session.agentType,
    session.workdir,
    session.status,
    session.acpxRecordId ?? null,
    session.acpxSessionId ?? null,
    session.agentSessionId ?? null,
    session.pid ?? null,
    session.approvalPreset,
    session.createdAt.toISOString(),
    session.lastActivityAt.toISOString(),
    session.lastError ?? null,
    session.metadata ? JSON.stringify(session.metadata) : null,
  ];
}

class WriteQueue {
  private tail = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class InMemorySessionStore implements SessionStore {
  protected readonly sessions = new Map<string, SessionInfo>();
  protected readonly writes = new WriteQueue();

  async create(session: SessionInfo): Promise<void> {
    await this.writes.enqueue(async () => {
      this.sessions.set(session.id, cloneSession(session));
      await this.afterWrite();
    });
  }

  async get(id: string): Promise<SessionInfo | null> {
    return this.getSync(id);
  }

  getSync(id: string): SessionInfo | null {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : null;
  }

  async getByAcpxRecordId(recordId: string): Promise<SessionInfo | null> {
    for (const session of this.sessions.values()) {
      if (session.acpxRecordId === recordId) return cloneSession(session);
    }
    return null;
  }

  async findByScope(opts: {
    workdir: string;
    agentType: string;
    name?: string;
  }): Promise<SessionInfo | null> {
    for (const session of this.sessions.values()) {
      if (
        session.workdir === opts.workdir &&
        session.agentType === opts.agentType &&
        session.name === opts.name
      ) {
        return cloneSession(session);
      }
    }
    return null;
  }

  async list(filter?: SessionFilter): Promise<SessionInfo[]> {
    return this.listSync(filter);
  }

  listSync(filter?: SessionFilter): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => matchesFilter(session, filter))
      .map(cloneSession);
  }

  // The actual mutation, run ONLY inside the write queue so read-modify-write is
  // serialized. Never call from outside an enqueue() (would race).
  private async applyUpdateLocked(
    id: string,
    patch: Partial<SessionInfo>,
  ): Promise<void> {
    const current = this.sessions.get(id);
    if (!current) return;
    const next: SessionInfo = {
      ...current,
      ...patch,
      lastActivityAt: patch.lastActivityAt
        ? new Date(patch.lastActivityAt)
        : new Date(),
      createdAt: patch.createdAt
        ? new Date(patch.createdAt)
        : current.createdAt,
      metadata: patch.metadata
        ? { ...patch.metadata }
        : current.metadata
          ? { ...current.metadata }
          : undefined,
    };
    this.sessions.set(id, next);
    await this.afterWrite();
  }

  async update(id: string, patch: Partial<SessionInfo>): Promise<void> {
    await this.writes.enqueue(() => this.applyUpdateLocked(id, patch));
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    error?: string,
  ): Promise<void> {
    // Guard + mutate atomically inside ONE queued op. Reading `current` outside
    // the queue let two concurrent updates both observe a non-terminal status
    // and both pass the guard, so one could downgrade a terminal status back to
    // a live one (a stopped/errored session flipping back to running).
    await this.writes.enqueue(async () => {
      const current = this.sessions.get(id);
      if (
        current &&
        TERMINAL_SESSION_STATUSES.has(current.status) &&
        !TERMINAL_SESSION_STATUSES.has(status)
      ) {
        return;
      }
      const patch: Partial<SessionInfo> = { status };
      if (status === "errored") patch.lastError = error;
      await this.applyUpdateLocked(id, patch);
    });
  }

  async delete(id: string): Promise<void> {
    await this.writes.enqueue(async () => {
      this.sessions.delete(id);
      await this.afterWrite();
    });
  }

  async sweepStale(maxAgeMs: number): Promise<string[]> {
    return this.writes.enqueue(async () => {
      const now = Date.now();
      const staleIds = [...this.sessions.values()]
        .filter(
          (session) =>
            (session.status === "stopped" || session.status === "errored") &&
            now - session.lastActivityAt.getTime() > maxAgeMs,
        )
        .map((session) => session.id);
      for (const id of staleIds) this.sessions.delete(id);
      if (staleIds.length > 0) await this.afterWrite();
      return staleIds;
    });
  }

  protected async afterWrite(): Promise<void> {
    // Implemented by durable subclasses.
  }
}

export class FileSessionStore extends InMemorySessionStore {
  private readonly lockFile: string;
  private loaded = false;

  constructor(
    private readonly filePath = resolveStateFile(),
    private readonly logger?: Logger,
  ) {
    super();
    this.lockFile = `${filePath}.lock`;
  }

  async create(session: SessionInfo): Promise<void> {
    await this.load();
    await super.create(session);
  }

  async get(id: string): Promise<SessionInfo | null> {
    await this.load();
    return super.get(id);
  }

  async getByAcpxRecordId(recordId: string): Promise<SessionInfo | null> {
    await this.load();
    return super.getByAcpxRecordId(recordId);
  }

  async findByScope(opts: {
    workdir: string;
    agentType: string;
    name?: string;
  }): Promise<SessionInfo | null> {
    await this.load();
    return super.findByScope(opts);
  }

  async list(filter?: SessionFilter): Promise<SessionInfo[]> {
    await this.load();
    return super.list(filter);
  }

  async update(id: string, patch: Partial<SessionInfo>): Promise<void> {
    await this.load();
    await super.update(id, patch);
  }

  override async updateStatus(
    id: string,
    status: SessionStatus,
    error?: string,
  ): Promise<void> {
    // Reload from disk first so the terminal-status guard sees a concurrent
    // process's writes (mirrors update()/delete()). super.updateStatus then runs
    // the guard + mutate atomically inside the write queue.
    await this.load();
    await super.updateStatus(id, status, error);
  }

  async delete(id: string): Promise<void> {
    await this.load();
    await super.delete(id);
  }

  async sweepStale(maxAgeMs: number): Promise<string[]> {
    await this.load();
    return super.sweepStale(maxAgeMs);
  }

  protected override async afterWrite(): Promise<void> {
    await this.withLock(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const payload = JSON.stringify(
        [...this.sessions.values()].map(toStoredSession),
        null,
        2,
      );
      await writeFile(tempPath, `${payload}\n`, "utf8");
      await rename(tempPath, this.filePath);
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await this.writes.enqueue(async () => {
      if (this.loaded) return;
      try {
        const contents = await readFile(this.filePath, "utf8");
        const parsed = JSON.parse(contents) as unknown;
        if (!Array.isArray(parsed))
          throw new Error("Session store JSON must be an array");
        this.sessions.clear();
        for (const raw of parsed) {
          if (!isRecord(raw)) continue;
          this.sessions.set(
            String(raw.id),
            fromStoredSession(raw as StoredSession),
          );
        }
      } catch (error) {
        const code =
          isRecord(error) && typeof error.code === "string"
            ? error.code
            : undefined;
        if (code !== "ENOENT") {
          this.logger?.warn?.(
            "acpx SessionStore JSON could not be read; starting with an empty store",
            error,
          );
        }
        this.sessions.clear();
      }
      this.loaded = true;
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
          isRecord(error) && typeof error.code === "string"
            ? error.code
            : undefined;
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
      this.logger?.warn?.(
        "acpx SessionStore removed a stale lock file",
        this.lockFile,
      );
    } catch (error) {
      const code =
        isRecord(error) && typeof error.code === "string"
          ? error.code
          : undefined;
      if (code !== "ENOENT") throw error;
    }
  }
}

/** SQL backend for ACP session state.
 *
 * Accepts either a raw sqlite-style adapter (older test harnesses,
 * hand-rolled bindings) or an eliza `BaseDrizzleAdapter` (postgres/pglite),
 * routing through {@link resolveSqlExecutor}. Upsert SQL uses `ON CONFLICT`
 * so it's portable across postgres, pglite, and sqlite ≥3.24. */
export class RuntimeDbSessionStore implements SessionStore {
  private readonly writes = new WriteQueue();
  private initPromise: Promise<void> | undefined;
  private executor: SqlExecutor | undefined;

  constructor(
    private readonly adapter: RawSqlDatabaseAdapter | ElizaDrizzleAdapter,
    private readonly logger?: Logger,
  ) {
    void this.logger;
  }

  async create(session: SessionInfo): Promise<void> {
    await this.writes.enqueue(async () => {
      await this.ensureInitialized();
      await this.upsert(session);
    });
  }

  async get(id: string): Promise<SessionInfo | null> {
    await this.ensureInitialized();
    return this.getOne("SELECT * FROM acp_sessions WHERE id = ?", [id]);
  }

  async getByAcpxRecordId(recordId: string): Promise<SessionInfo | null> {
    await this.ensureInitialized();
    return this.getOne("SELECT * FROM acp_sessions WHERE acpx_record_id = ?", [
      recordId,
    ]);
  }

  async findByScope(opts: {
    workdir: string;
    agentType: string;
    name?: string;
  }): Promise<SessionInfo | null> {
    await this.ensureInitialized();
    if (opts.name === undefined) {
      return this.getOne(
        "SELECT * FROM acp_sessions WHERE workdir = ? AND agent_type = ? AND name IS NULL ORDER BY created_at DESC LIMIT 1",
        [opts.workdir, opts.agentType],
      );
    }
    return this.getOne(
      "SELECT * FROM acp_sessions WHERE workdir = ? AND agent_type = ? AND name = ? ORDER BY created_at DESC LIMIT 1",
      [opts.workdir, opts.agentType, opts.name],
    );
  }

  async list(filter?: SessionFilter): Promise<SessionInfo[]> {
    await this.ensureInitialized();
    const sessions = (await this.getMany("SELECT * FROM acp_sessions", [])).map(
      cloneSession,
    );
    return sessions.filter((session) => matchesFilter(session, filter));
  }

  // The actual mutation, run ONLY inside the write queue so read-modify-write is
  // serialized. Never call from outside an enqueue() (would race).
  private async applyUpdateLocked(
    id: string,
    patch: Partial<SessionInfo>,
  ): Promise<void> {
    await this.ensureInitialized();
    const current = await this.getOne(
      "SELECT * FROM acp_sessions WHERE id = ?",
      [id],
    );
    if (!current) return;
    await this.upsert({
      ...current,
      ...patch,
      createdAt: patch.createdAt
        ? new Date(patch.createdAt)
        : current.createdAt,
      lastActivityAt: patch.lastActivityAt
        ? new Date(patch.lastActivityAt)
        : new Date(),
      metadata: patch.metadata ? { ...patch.metadata } : current.metadata,
    });
  }

  async update(id: string, patch: Partial<SessionInfo>): Promise<void> {
    await this.writes.enqueue(() => this.applyUpdateLocked(id, patch));
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    error?: string,
  ): Promise<void> {
    // Guard + mutate atomically inside ONE queued op. Reading `current` outside
    // the queue let a concurrent update slip a terminal status back to a live
    // one (the same race as InMemorySessionStore).
    await this.writes.enqueue(async () => {
      await this.ensureInitialized();
      const current = await this.getOne(
        "SELECT * FROM acp_sessions WHERE id = ?",
        [id],
      );
      if (
        current &&
        TERMINAL_SESSION_STATUSES.has(current.status) &&
        !TERMINAL_SESSION_STATUSES.has(status)
      ) {
        return;
      }
      const patch: Partial<SessionInfo> = { status };
      if (status === "errored") patch.lastError = error;
      await this.applyUpdateLocked(id, patch);
    });
  }

  async delete(id: string): Promise<void> {
    await this.writes.enqueue(async () => {
      await this.ensureInitialized();
      await this.execute("DELETE FROM acp_sessions WHERE id = ?", [id]);
    });
  }

  async sweepStale(maxAgeMs: number): Promise<string[]> {
    return this.writes.enqueue(async () => {
      await this.ensureInitialized();
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
      const stale = await this.getMany(
        "SELECT * FROM acp_sessions WHERE (status = ? OR status = ?) AND last_activity_at < ?",
        ["stopped", "errored", cutoff],
      );
      for (const session of stale) {
        await this.execute("DELETE FROM acp_sessions WHERE id = ?", [
          session.id,
        ]);
      }
      return stale.map((session) => session.id);
    });
  }

  private async ensureInitialized(): Promise<void> {
    this.initPromise ??= (async () => {
      this.executor = await resolveSqlExecutor(this.adapter);
      await this.executor.run(SESSION_TABLE_SQL);
      for (const sql of SESSION_INDEX_SQL) await this.executor.run(sql);
    })();
    await this.initPromise;
  }

  private exec(): SqlExecutor {
    if (!this.executor) {
      throw new Error(
        "acpx session-store: executor accessed before ensureInitialized()",
      );
    }
    return this.executor;
  }

  private async upsert(session: SessionInfo): Promise<void> {
    // Portable upsert. Postgres/pglite need ON CONFLICT DO UPDATE; sqlite
    // ≥3.24 accepts the same syntax. Named-column DO UPDATE avoids the
    // sqlite-only INSERT OR REPLACE form we used to emit.
    await this.exec().run(
      `INSERT INTO acp_sessions (
        id, name, agent_type, workdir, status, acpx_record_id, acpx_session_id, agent_session_id,
        pid, approval_preset, created_at, last_activity_at, last_error, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        agent_type = excluded.agent_type,
        workdir = excluded.workdir,
        status = excluded.status,
        acpx_record_id = excluded.acpx_record_id,
        acpx_session_id = excluded.acpx_session_id,
        agent_session_id = excluded.agent_session_id,
        pid = excluded.pid,
        approval_preset = excluded.approval_preset,
        created_at = excluded.created_at,
        last_activity_at = excluded.last_activity_at,
        last_error = excluded.last_error,
        metadata = excluded.metadata`,
      sessionToParams(session),
    );
  }

  private async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.exec().run(sql, params);
  }

  private async getMany(
    sql: string,
    params: unknown[],
  ): Promise<SessionInfo[]> {
    const rows = await this.exec().all(sql, params);
    return rows.map(rowToSession);
  }

  private async getOne(
    sql: string,
    params: unknown[],
  ): Promise<SessionInfo | null> {
    const [row] = await this.getMany(sql, params);
    return row ?? null;
  }
}

export interface AcpSessionStoreOptions {
  runtime?: SessionStoreRuntime;
  stateFile?: string;
  backend?: SessionStoreBackend;
}

export class AcpSessionStore implements SessionStore {
  readonly backend: SessionStoreBackend;
  private readonly delegate: SessionStore;

  constructor(options: AcpSessionStoreOptions = {}) {
    // Prefer the modern `runtime.adapter` property (packages/core/src/runtime.ts
    // declares `public adapter!: IDatabaseAdapter`); fall back to the legacy
    // `runtime.databaseAdapter` name that older test harnesses and some custom
    // container runtimes still use.
    const adapter =
      options.runtime?.adapter ?? options.runtime?.databaseAdapter;
    const logger = options.runtime?.logger;
    if (
      (options.backend === undefined || options.backend === "runtime-db") &&
      isPersistableAdapter(adapter)
    ) {
      this.backend = "runtime-db";
      this.delegate = new RuntimeDbSessionStore(adapter, logger);
      return;
    }

    if (options.backend === "memory") {
      this.backend = "memory";
      this.delegate = new InMemorySessionStore();
      logger?.warn?.(
        "acpx SessionStore is using in-memory storage; sessions will not persist across restarts",
      );
      return;
    }

    const filePath = resolveStateFile(options.runtime, options.stateFile);
    this.backend = "file";
    this.delegate = new FileSessionStore(filePath, logger);
  }

  create(session: SessionInfo): Promise<void> {
    return this.delegate.create(session);
  }

  get(id: string): Promise<SessionInfo | null> {
    return this.delegate.get(id);
  }

  getByAcpxRecordId(recordId: string): Promise<SessionInfo | null> {
    return this.delegate.getByAcpxRecordId(recordId);
  }

  findByScope(opts: {
    workdir: string;
    agentType: string;
    name?: string;
  }): Promise<SessionInfo | null> {
    return this.delegate.findByScope(opts);
  }

  list(filter?: SessionFilter): Promise<SessionInfo[]> {
    return this.delegate.list(filter);
  }

  update(id: string, patch: Partial<SessionInfo>): Promise<void> {
    return this.delegate.update(id, patch);
  }

  updateStatus(
    id: string,
    status: SessionStatus,
    error?: string,
  ): Promise<void> {
    return this.delegate.updateStatus(id, status, error);
  }

  delete(id: string): Promise<void> {
    return this.delegate.delete(id);
  }

  sweepStale(maxAgeMs: number): Promise<string[]> {
    return this.delegate.sweepStale(maxAgeMs);
  }
}

export type {
  SessionFilter,
  SessionInfo,
  SessionStatus,
  SessionStore,
} from "./types.js";
