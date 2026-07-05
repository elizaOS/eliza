/**
 * Durable registry of coding "projects": a stable `id → { name, rootDir }`
 * binding a task pins via {@link OrchestratorTaskRecord.projectId} so every
 * session it spawns targets one workspace root instead of drifting per spawn
 * (#13776). `rootDir` is the natural key — one project per resolved absolute
 * root — which keeps {@link ProjectRegistry.resolveProject} unambiguous.
 *
 * Persistence mirrors the task store's tiered backend selection: a runtime SQL
 * adapter when present, else a lock-guarded JSON file, else process memory. It
 * reuses that store's SQL executor plumbing ({@link resolveSqlExecutor},
 * {@link isPersistableAdapter}) so both tables sit on the same adapter behind
 * one code path for the drizzle / raw-sqlite / pglite shapes.
 *
 * Records are immutable after creation (a project's name, root, and createdAt
 * never change), which is why the file backend can union-merge concurrent
 * inserts by id with no dirty-tracking or tombstones.
 *
 * @module services/project-registry
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
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  type ElizaDrizzleAdapter,
  isPersistableAdapter,
  type RawSqlDatabaseAdapter,
  resolveSqlExecutor,
  type SqlExecutor,
  type TaskStoreRuntime,
} from "./orchestrator-task-store.js";

export type ProjectRegistryBackend = "runtime-db" | "file" | "memory";

export interface ProjectRecord {
  id: string;
  name: string;
  /** Absolute, normalized workspace root — the registry's natural key. */
  rootDir: string;
  createdAt: string;
}

export interface CreateProjectInput {
  name: string;
  rootDir: string;
}

interface Logger {
  warn?: (message: string, ...args: unknown[]) => void;
}

const FILE_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const FILE_LOCK_STALE_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Normalize a workspace root to the registry's natural key: an absolute path
 * with trailing separators collapsed, so `/repo`, `/repo/`, and `/repo/.` all
 * resolve to the same project. */
function normalizeRootDir(rootDir: string): string {
  return resolvePath(rootDir);
}

function normalizeProject(value: unknown): ProjectRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.rootDir !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    rootDir: value.rootDir,
    createdAt: value.createdAt,
  };
}

function newProject(input: CreateProjectInput): ProjectRecord {
  return {
    id: randomUUID(),
    name: input.name.trim() || "Untitled project",
    rootDir: normalizeRootDir(input.rootDir),
    createdAt: new Date().toISOString(),
  };
}

/**
 * In-memory backend. The file backend extends this with JSON persistence; the
 * SQL backend reimplements the same surface against a runtime adapter.
 *
 * `createProject` is idempotent on the normalized `rootDir` (returns the
 * existing project rather than minting a duplicate), so `resolveProject` always
 * has at most one candidate — the whole point of a first-class binding.
 */
export class InMemoryProjectStore {
  protected readonly projects = new Map<string, ProjectRecord>();
  private tail = Promise.resolve();

  protected enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    return this.enqueue(async () => {
      const rootDir = normalizeRootDir(input.rootDir);
      const existing = this.findByRoot(rootDir);
      if (existing) return { ...existing };
      const project = newProject({ name: input.name, rootDir });
      this.projects.set(project.id, project);
      await this.afterWrite();
      return { ...project };
    });
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return [...this.projects.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((project) => ({ ...project }));
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    const project = this.projects.get(id);
    return project ? { ...project } : null;
  }

  async resolveProject(rootDir: string): Promise<ProjectRecord | null> {
    const found = this.findByRoot(normalizeRootDir(rootDir));
    return found ? { ...found } : null;
  }

  private findByRoot(rootDir: string): ProjectRecord | undefined {
    for (const project of this.projects.values()) {
      if (project.rootDir === rootDir) return project;
    }
    return undefined;
  }

  protected async afterWrite(): Promise<void> {
    // Durable subclasses persist here.
  }

  /** Replace the in-memory set from a durable source. */
  hydrate(projects: ProjectRecord[]): void {
    this.projects.clear();
    for (const project of projects) this.projects.set(project.id, project);
  }
}

function defaultProjectsFile(runtime?: TaskStoreRuntime): string {
  const configured =
    process.env.ELIZA_ACP_STATE_DIR ??
    runtime?.getSetting?.("ELIZA_ACP_STATE_DIR");
  const base = configured ?? join(homedir(), ".eliza", "plugin-acp");
  return join(base, "orchestrator-projects.json");
}

export class FileProjectStore extends InMemoryProjectStore {
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
    await this.enqueue(async () => {
      if (this.loaded) return;
      this.hydrate(await this.readFromDisk());
      this.loaded = true;
    });
  }

  private async readFromDisk(): Promise<ProjectRecord[]> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(normalizeProject)
        .filter((project): project is ProjectRecord => project !== null);
    } catch (error) {
      // error-policy:J3 persisted-store load: ENOENT = no file yet, any other
      // read/parse error warns and starts empty (observable recovery).
      const code =
        isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT") {
        this.logger?.warn?.(
          "[ProjectRegistry] projects file unreadable; starting empty",
          error,
        );
      }
      return [];
    }
  }

  override async createProject(input: CreateProjectInput) {
    await this.ensureLoaded();
    return super.createProject(input);
  }
  override async listProjects() {
    await this.ensureLoaded();
    return super.listProjects();
  }
  override async getProject(id: string) {
    await this.ensureLoaded();
    return super.getProject(id);
  }
  override async resolveProject(rootDir: string) {
    await this.ensureLoaded();
    return super.resolveProject(rootDir);
  }

  protected override async afterWrite(): Promise<void> {
    await this.withLock(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      // Read-merge-write under the lock so a concurrent process's inserts
      // survive. Records are immutable, so a union by id is exact: seed from
      // disk, then overlay this process's in-memory set.
      const merged = new Map<string, ProjectRecord>();
      for (const project of await this.readFromDisk()) {
        merged.set(project.id, project);
      }
      for (const [id, project] of this.projects) merged.set(id, project);
      this.hydrate([...merged.values()]);
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(
        tempPath,
        `${JSON.stringify([...merged.values()], null, 2)}\n`,
        "utf8",
      );
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
        // error-policy:J3 lock-acquire: EEXIST (lock held) is retried until the
        // deadline; every other error is rethrown below (fail-fast).
        if (pending) {
          // error-policy:J6 best-effort teardown — unwind a partial acquire.
          await pending.close().catch(() => {});
          await rm(this.lockFile, { force: true }).catch(() => {});
        }
        const code =
          isRecord(error) && typeof error.code === "string" ? error.code : "";
        if (code !== "EEXIST" || Date.now() > deadline) throw error;
        await this.removeStaleLock();
        await new Promise((r) => setTimeout(r, 25));
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

const PROJECT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS orchestrator_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_dir TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

const PROJECT_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_orch_projects_root ON orchestrator_projects(root_dir)";

/** SQL backend. One row per project; reuses the task store's executor so it
 * runs on the same drizzle / raw / pglite adapter. */
export class RuntimeDbProjectStore {
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
      const executor = await resolveSqlExecutor(this.adapter);
      this.executor = executor;
      await executor.run(PROJECT_TABLE_SQL);
      await executor.run(PROJECT_INDEX_SQL);
    })();
    await this.initPromise;
  }

  private exec(): SqlExecutor {
    if (!this.executor) {
      throw new Error(
        "project-registry: executor accessed before ensureInitialized()",
      );
    }
    return this.executor;
  }

  private parseRow(row: unknown): ProjectRecord | null {
    if (!isRecord(row)) return null;
    return normalizeProject({
      id: row.id,
      name: row.name,
      rootDir: row.root_dir,
      createdAt: row.created_at,
    });
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const rootDir = normalizeRootDir(input.rootDir);
      const existing = await this.selectByRoot(rootDir);
      if (existing) return existing;
      const project = newProject({ name: input.name, rootDir });
      await this.exec().run(
        `INSERT INTO orchestrator_projects (id, name, root_dir, created_at)
         VALUES (?, ?, ?, ?)`,
        [project.id, project.name, project.rootDir, project.createdAt],
      );
      return project;
    });
  }

  async listProjects(): Promise<ProjectRecord[]> {
    await this.ensureInitialized();
    const rows = await this.exec().all(
      "SELECT id, name, root_dir, created_at FROM orchestrator_projects ORDER BY created_at ASC",
    );
    return rows
      .map((row) => this.parseRow(row))
      .filter((project): project is ProjectRecord => project !== null);
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    await this.ensureInitialized();
    const rows = await this.exec().all(
      "SELECT id, name, root_dir, created_at FROM orchestrator_projects WHERE id = ?",
      [id],
    );
    return rows.length > 0 ? this.parseRow(rows[0]) : null;
  }

  async resolveProject(rootDir: string): Promise<ProjectRecord | null> {
    await this.ensureInitialized();
    return this.selectByRoot(normalizeRootDir(rootDir));
  }

  private async selectByRoot(rootDir: string): Promise<ProjectRecord | null> {
    const rows = await this.exec().all(
      "SELECT id, name, root_dir, created_at FROM orchestrator_projects WHERE root_dir = ? ORDER BY created_at ASC LIMIT 1",
      [rootDir],
    );
    return rows.length > 0 ? this.parseRow(rows[0]) : null;
  }
}

export interface ProjectRegistryOptions {
  runtime?: TaskStoreRuntime;
  stateFile?: string;
  backend?: ProjectRegistryBackend;
}

/**
 * Backend-selecting facade — the registry consumers use. Mirrors
 * {@link OrchestratorTaskStore}'s selection order so a runtime with a SQL
 * adapter persists projects alongside tasks, while a no-DB runtime falls back
 * to a JSON file (then memory).
 */
export class ProjectRegistry {
  readonly backend: ProjectRegistryBackend;
  private readonly delegate: InMemoryProjectStore | RuntimeDbProjectStore;

  constructor(options: ProjectRegistryOptions = {}) {
    const adapter =
      options.runtime?.adapter ?? options.runtime?.databaseAdapter;
    if (
      (options.backend === undefined || options.backend === "runtime-db") &&
      isPersistableAdapter(adapter)
    ) {
      this.backend = "runtime-db";
      this.delegate = new RuntimeDbProjectStore(adapter);
      return;
    }
    if (options.backend === "memory") {
      this.backend = "memory";
      this.delegate = new InMemoryProjectStore();
      return;
    }
    this.backend = "file";
    this.delegate = new FileProjectStore(
      options.stateFile ?? defaultProjectsFile(options.runtime),
      options.runtime?.logger,
    );
  }

  createProject(input: CreateProjectInput) {
    return this.delegate.createProject(input);
  }
  listProjects() {
    return this.delegate.listProjects();
  }
  getProject(id: string) {
    return this.delegate.getProject(id);
  }
  resolveProject(rootDir: string) {
    return this.delegate.resolveProject(rootDir);
  }
}
