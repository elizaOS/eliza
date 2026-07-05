/**
 * First-class Project registry for the orchestrator (#13776, design D3).
 *
 * A Project is the durable binding a coding task hangs off: a name, a local
 * working tree, an optional remote repo + default branch, and the elizaOS
 * `worldId` its memory/knowledge is partitioned into. Before this, "project"
 * meant one global workspace directory per runtime process — picking a folder
 * replaced the previous one, so switching projects meant mutating global state
 * and every task derived its repo from whichever session ran last. The registry
 * replaces that single-value config with a set of named projects plus one
 * `activeProjectId`; the current-folder model becomes the degenerate
 * one-project case ({@link ProjectRegistry.ensureProjectForPath}).
 *
 * Memory scoping follows D3's cheaper option: each Project maps to a dedicated
 * `worldId` (a free partition in the existing memory schema, no column change)
 * so a subagent working project B never sees project A's injected context. The
 * VFS `projectId` (workbench sandbox) is a separate concept and is not touched
 * here.
 *
 * Persistence is a single JSON snapshot (memory or file backend). A registry is
 * low-cardinality — a handful of projects per user — so unlike the task store it
 * needs no SQL backend; the file it replaces was itself a single config value.
 *
 * @module services/project-registry
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A durable project the orchestrator can bind tasks and workspaces to. */
export interface Project {
  id: string;
  name: string;
  /** Absolute path to the project's working tree (the git checkout). */
  localPath?: string;
  /** Remote repository URL when the project is repo-hosted (e.g. GitHub). */
  repoUrl?: string;
  /** Branch new task workspaces are cut from. */
  defaultBranch?: string;
  /** elizaOS world this project's memory/knowledge is partitioned into. Each
   * project gets its own world so context does not leak across projects. */
  worldId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Caller-supplied fields for {@link ProjectRegistry.createProject}; the
 * registry mints `id`/timestamps and defaults `metadata`. */
export interface CreateProjectInput {
  name: string;
  localPath?: string;
  repoUrl?: string;
  defaultBranch?: string;
  worldId?: string;
  metadata?: Record<string, unknown>;
}

/** Fields a caller may patch. `id`, `createdAt` are immutable; `updatedAt` is
 * managed by the registry. */
export type UpdateProjectInput = Partial<
  Pick<
    Project,
    "name" | "localPath" | "repoUrl" | "defaultBranch" | "worldId" | "metadata"
  >
>;

/** The full persisted registry state: the project set plus which one is active. */
export interface ProjectRegistrySnapshot {
  projects: Project[];
  activeProjectId?: string;
}

export type ProjectRegistryBackend = "file" | "memory";

interface Logger {
  warn?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
}

interface ProjectRegistryRuntime {
  logger?: Logger;
  getSetting?: (key: string) => string | undefined;
}

export interface ProjectRegistryOptions {
  runtime?: ProjectRegistryRuntime;
  stateFile?: string;
  backend?: ProjectRegistryBackend;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Boundary guard for a project loaded from disk: it must carry a string id and
 * name. Anything else is dropped rather than trusted. */
function normalizeProject(value: unknown): Project | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  const str = (key: string): string | undefined =>
    typeof value[key] === "string" ? (value[key] as string) : undefined;
  return {
    id: value.id,
    name: value.name,
    localPath: str("localPath"),
    repoUrl: str("repoUrl"),
    defaultBranch: str("defaultBranch"),
    worldId: str("worldId"),
    metadata: isRecord(value.metadata) ? value.metadata : {},
    createdAt: str("createdAt") ?? nowIso(),
    updatedAt: str("updatedAt") ?? nowIso(),
  };
}

function normalizeSnapshot(value: unknown): ProjectRegistrySnapshot {
  if (!isRecord(value) || !Array.isArray(value.projects)) {
    return { projects: [] };
  }
  const projects = value.projects
    .map(normalizeProject)
    .filter((p): p is Project => p !== null);
  const activeProjectId =
    typeof value.activeProjectId === "string" &&
    projects.some((p) => p.id === value.activeProjectId)
      ? value.activeProjectId
      : undefined;
  return { projects, activeProjectId };
}

function defaultStateFile(runtime?: ProjectRegistryRuntime): string {
  const configured =
    process.env.ELIZA_ACP_STATE_DIR ??
    runtime?.getSetting?.("ELIZA_ACP_STATE_DIR");
  const base = configured ?? join(homedir(), ".eliza", "plugin-acp");
  return join(base, "orchestrator-projects.json");
}

/**
 * In-memory backend. The file backend extends it with JSON persistence. All
 * mutations run through a single-writer queue so concurrent callers cannot
 * interleave a read-modify-write.
 */
export class InMemoryProjectRegistry {
  protected projects = new Map<string, Project>();
  protected activeProjectId: string | undefined;
  private tail = Promise.resolve();

  protected enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Hook the file backend overrides to flush the snapshot after a mutation. */
  protected async afterWrite(): Promise<void> {}

  /** Hook the file backend overrides to load persisted state before a read. */
  protected async ensureLoaded(): Promise<void> {}

  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.enqueue(async () => {
      const ts = nowIso();
      const project: Project = {
        id: randomUUID(),
        name: input.name.trim() || "Untitled project",
        localPath: input.localPath,
        repoUrl: input.repoUrl,
        defaultBranch: input.defaultBranch,
        worldId: input.worldId,
        metadata: input.metadata ?? {},
        createdAt: ts,
        updatedAt: ts,
      };
      this.projects.set(project.id, project);
      // First project registered becomes active — the common single-project
      // case should never leave `activeProjectId` unset.
      this.activeProjectId ??= project.id;
      await this.afterWrite();
      return structuredClone(project);
    });
  }

  async getProject(id: string): Promise<Project | null> {
    await this.ensureLoaded();
    const project = this.projects.get(id);
    return project ? structuredClone(project) : null;
  }

  async listProjects(): Promise<Project[]> {
    await this.ensureLoaded();
    return [...this.projects.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => structuredClone(p));
  }

  async updateProject(
    id: string,
    patch: UpdateProjectInput,
  ): Promise<Project | null> {
    return this.enqueue(async () => {
      const existing = this.projects.get(id);
      if (!existing) return null;
      const next: Project = {
        ...existing,
        ...omitUndefined(patch),
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
      };
      this.projects.set(id, next);
      await this.afterWrite();
      return structuredClone(next);
    });
  }

  async removeProject(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const existed = this.projects.delete(id);
      if (!existed) return false;
      if (this.activeProjectId === id) {
        // Never leave the pointer dangling at a deleted project; fall back to
        // any remaining project so "active" stays a valid handle.
        this.activeProjectId = this.projects.keys().next().value;
      }
      await this.afterWrite();
      return true;
    });
  }

  async getActiveProjectId(): Promise<string | undefined> {
    await this.ensureLoaded();
    return this.activeProjectId;
  }

  async getActiveProject(): Promise<Project | null> {
    const id = await this.getActiveProjectId();
    return id ? this.getProject(id) : null;
  }

  async setActiveProject(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.projects.has(id)) {
        throw new Error(
          `[ProjectRegistry] cannot activate unknown project ${id}`,
        );
      }
      this.activeProjectId = id;
      await this.afterWrite();
    });
  }

  /**
   * Idempotently resolve the project for a working-tree path — the migration
   * seam from the old single-folder config. Returns the existing project bound
   * to `localPath` if any, else registers a new one. Lets a folder-picker flow
   * keep working while every task gets a real project binding.
   */
  async ensureProjectForPath(
    localPath: string,
    name?: string,
  ): Promise<Project> {
    await this.ensureLoaded();
    const existing = [...this.projects.values()].find(
      (p) => p.localPath === localPath,
    );
    if (existing) return structuredClone(existing);
    return this.createProject({
      name: name ?? basenameOf(localPath),
      localPath,
    });
  }

  protected snapshot(): ProjectRegistrySnapshot {
    return {
      projects: [...this.projects.values()].map((p) => structuredClone(p)),
      activeProjectId: this.activeProjectId,
    };
  }

  protected hydrate(snapshot: ProjectRegistrySnapshot): void {
    this.projects = new Map(snapshot.projects.map((p) => [p.id, p]));
    this.activeProjectId = snapshot.activeProjectId;
  }
}

function omitUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined,
    ),
  ) as Partial<T>;
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}

/** File-backed registry: one JSON snapshot, loaded lazily and rewritten
 * atomically (temp file + rename) after every mutation. */
export class FileProjectRegistry extends InMemoryProjectRegistry {
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly logger?: Logger,
  ) {
    super();
  }

  protected override async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.enqueue(async () => {
      if (this.loaded) return;
      try {
        const contents = await readFile(this.filePath, "utf8");
        this.hydrate(normalizeSnapshot(JSON.parse(contents)));
      } catch (error) {
        // error-policy:J3 persisted-store load: ENOENT = no registry yet; any
        // other read/parse error warns and starts empty (observable recovery).
        const code =
          isRecord(error) && typeof error.code === "string" ? error.code : "";
        if (code !== "ENOENT") {
          this.logger?.warn?.(
            "[ProjectRegistry] registry file unreadable; starting empty",
            error,
          );
        }
        this.hydrate({ projects: [] });
      }
      this.loaded = true;
    });
  }

  protected override async afterWrite(): Promise<void> {
    const payload = JSON.stringify(this.snapshot(), null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, this.filePath);
  }

  override async createProject(input: CreateProjectInput): Promise<Project> {
    await this.ensureLoaded();
    return super.createProject(input);
  }

  override async updateProject(
    id: string,
    patch: UpdateProjectInput,
  ): Promise<Project | null> {
    await this.ensureLoaded();
    return super.updateProject(id, patch);
  }

  override async removeProject(id: string): Promise<boolean> {
    await this.ensureLoaded();
    return super.removeProject(id);
  }

  override async setActiveProject(id: string): Promise<void> {
    await this.ensureLoaded();
    return super.setActiveProject(id);
  }
}

/** Backend-selecting facade. Mirrors {@link OrchestratorTaskStore}: memory when
 * requested, else a JSON file. */
export class ProjectRegistry {
  readonly backend: ProjectRegistryBackend;
  private readonly delegate: InMemoryProjectRegistry;

  constructor(options: ProjectRegistryOptions = {}) {
    if (options.backend === "memory") {
      this.backend = "memory";
      this.delegate = new InMemoryProjectRegistry();
      return;
    }
    this.backend = "file";
    this.delegate = new FileProjectRegistry(
      options.stateFile ?? defaultStateFile(options.runtime),
      options.runtime?.logger,
    );
  }

  createProject(input: CreateProjectInput) {
    return this.delegate.createProject(input);
  }
  getProject(id: string) {
    return this.delegate.getProject(id);
  }
  listProjects() {
    return this.delegate.listProjects();
  }
  updateProject(id: string, patch: UpdateProjectInput) {
    return this.delegate.updateProject(id, patch);
  }
  removeProject(id: string) {
    return this.delegate.removeProject(id);
  }
  getActiveProjectId() {
    return this.delegate.getActiveProjectId();
  }
  getActiveProject() {
    return this.delegate.getActiveProject();
  }
  setActiveProject(id: string) {
    return this.delegate.setActiveProject(id);
  }
  ensureProjectForPath(localPath: string, name?: string) {
    return this.delegate.ensureProjectForPath(localPath, name);
  }
}
