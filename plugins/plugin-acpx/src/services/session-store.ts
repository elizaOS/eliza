import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  SessionFilter,
  SessionInfo,
  SessionStatus,
  SessionStore,
  SessionStoreRuntime,
} from "./types.js";

export type SessionStoreBackend = "runtime-db" | "file" | "memory";

type Logger = NonNullable<SessionStoreRuntime["logger"]>;

type SqlDatabaseAdapter = {
  query?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  execute?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  run?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  all?: (sql: string, params?: unknown[]) => Promise<unknown[]> | unknown[];
  get?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  select?: (sql: string, params?: unknown[]) => Promise<unknown[]> | unknown[];
};

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

function isSqlDatabaseAdapter(value: unknown): value is SqlDatabaseAdapter {
  if (!isRecord(value)) return false;
  return ["query", "execute", "run", "all", "get", "select"].some(
    (method) => typeof value[method] === "function",
  );
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

  async update(id: string, patch: Partial<SessionInfo>): Promise<void> {
    await this.writes.enqueue(async () => {
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
    });
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    error?: string,
  ): Promise<void> {
    const patch: Partial<SessionInfo> = { status };
    if (status === "errored") patch.lastError = error;
    await this.update(id, patch);
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
    const deadline = Date.now() + 5_000;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      try {
        handle = await open(this.lockFile, "wx");
      } catch (error) {
        const code =
          isRecord(error) && typeof error.code === "string"
            ? error.code
            : undefined;
        if (code !== "EEXIST" || Date.now() > deadline) throw error;
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
}

export class RuntimeDbSessionStore implements SessionStore {
  private readonly writes = new WriteQueue();
  private initPromise: Promise<void> | undefined;

  constructor(
    private readonly adapter: SqlDatabaseAdapter,
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

  async update(id: string, patch: Partial<SessionInfo>): Promise<void> {
    await this.writes.enqueue(async () => {
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
    });
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    error?: string,
  ): Promise<void> {
    const patch: Partial<SessionInfo> = { status };
    if (status === "errored") patch.lastError = error;
    await this.update(id, patch);
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
      await this.execute(SESSION_TABLE_SQL);
      for (const sql of SESSION_INDEX_SQL) await this.execute(sql);
    })();
    await this.initPromise;
  }

  private async upsert(session: SessionInfo): Promise<void> {
    await this.execute(
      `INSERT OR REPLACE INTO acp_sessions (
        id, name, agent_type, workdir, status, acpx_record_id, acpx_session_id, agent_session_id,
        pid, approval_preset, created_at, last_activity_at, last_error, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionToParams(session),
    );
  }

  private async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    const fn = this.adapter.execute ?? this.adapter.run ?? this.adapter.query;
    if (!fn)
      throw new Error(
        "Runtime database adapter does not expose execute, run, or query",
      );
    return fn.call(this.adapter, sql, params);
  }

  private async getMany(
    sql: string,
    params: unknown[],
  ): Promise<SessionInfo[]> {
    const fn = this.adapter.all ?? this.adapter.select ?? this.adapter.query;
    if (!fn)
      throw new Error(
        "Runtime database adapter does not expose all, select, or query",
      );
    const rows = normalizeRows(await fn.call(this.adapter, sql, params));
    return rows.map(rowToSession);
  }

  private async getOne(
    sql: string,
    params: unknown[],
  ): Promise<SessionInfo | null> {
    if (this.adapter.get) {
      const row = await this.adapter.get.call(this.adapter, sql, params);
      return row ? rowToSession(row) : null;
    }
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
    const adapter = options.runtime?.databaseAdapter;
    const logger = options.runtime?.logger;
    if (
      (options.backend === undefined || options.backend === "runtime-db") &&
      isSqlDatabaseAdapter(adapter)
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
    try {
      access(dirname(filePath), constants.W_OK).catch(() => undefined);
      this.backend = "file";
      this.delegate = new FileSessionStore(filePath, logger);
    } catch (error) {
      this.backend = "memory";
      this.delegate = new InMemorySessionStore();
      logger?.warn?.(
        "acpx SessionStore could not initialize file storage; sessions will not persist across restarts",
        error,
      );
    }
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
