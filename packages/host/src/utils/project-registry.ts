/**
 * Persists project bindings in the shared state directory for the agent runtime
 * and desktop picker. Workspace resolution runs before database startup, so
 * both processes exchange this state through an atomically replaced JSON file.
 * Local paths identify projects; cloud app ids bind subsequent tasks to an
 * existing deployment. Workbench VFS project ids are a separate namespace.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveStateDir } from "@elizaos/core";
import { ElizaError } from "@elizaos/core/protocol";
import { writeJsonFileAtomic } from "./atomic-json-file.js";

export interface ProjectRecord {
  id: string;
  name: string;
  /** Realpath-resolved local working directory. The project's identity key. */
  localPath: string;
  repoUrl?: string;
  defaultBranch?: string;
  /** Agent-scoped memory partition derived by core projectWorldId(agentId, id). */
  worldId?: string;
  /** macOS security-scoped bookmark for the picked folder, when present. */
  bookmark?: string | null;
  /** Cloud deployment bound to this project. */
  cloudAppId?: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface ProjectRegistry {
  version: 1;
  activeProjectId: string | null;
  projects: ProjectRecord[];
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return false;
  if (typeof obj.name !== "string") return false;
  if (typeof obj.localPath !== "string" || obj.localPath.length === 0)
    return false;
  if (obj.repoUrl !== undefined && typeof obj.repoUrl !== "string")
    return false;
  if (obj.defaultBranch !== undefined && typeof obj.defaultBranch !== "string")
    return false;
  if (obj.worldId !== undefined && typeof obj.worldId !== "string")
    return false;
  if (
    obj.bookmark !== undefined &&
    obj.bookmark !== null &&
    typeof obj.bookmark !== "string"
  )
    return false;
  if (obj.cloudAppId !== undefined && typeof obj.cloudAppId !== "string")
    return false;
  if (typeof obj.createdAt !== "string") return false;
  if (typeof obj.lastOpenedAt !== "string") return false;
  return true;
}

function isProjectRegistry(value: unknown): value is ProjectRegistry {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (obj.activeProjectId !== null && typeof obj.activeProjectId !== "string")
    return false;
  if (!Array.isArray(obj.projects)) return false;
  return obj.projects.every(isProjectRecord);
}

export function projectRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveStateDir(env), "projects.json");
}

function readStoredRegistry(env: NodeJS.ProcessEnv): unknown {
  const filePath = projectRegistryPath(env);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ElizaError("Cannot read the project registry", {
      code: "PROJECT_REGISTRY_READ_FAILED",
      context: { filePath },
      cause,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ElizaError("Malformed project registry JSON", {
      code: "PROJECT_REGISTRY_INVALID",
      context: { filePath },
      cause,
    });
  }
}

/** Read or migrate project state; invalid and unreadable files remain errors. */
export function readProjectRegistry(
  env: NodeJS.ProcessEnv = process.env,
): ProjectRegistry | null {
  const stored = readStoredRegistry(env);
  if (stored === undefined) return importWorkspaceSelection(env);
  if (!isProjectRegistry(stored))
    throw new ElizaError("Invalid project registry", {
      code: "PROJECT_REGISTRY_INVALID",
      context: { filePath: projectRegistryPath(env) },
    });
  return stored;
}

function importWorkspaceSelection(
  env: NodeJS.ProcessEnv,
): ProjectRegistry | null {
  const source = join(resolveStateDir(env), "workspace-folder.json");
  let raw: string;
  try {
    raw = readFileSync(source, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ElizaError("Cannot read workspace selection", {
      code: "PROJECT_SELECTION_READ_FAILED",
      context: { source },
      cause,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new ElizaError("Malformed workspace selection JSON", {
      code: "PROJECT_SELECTION_INVALID",
      context: { source },
      cause,
    });
  }
  const selection = value as Record<string, unknown> | null;
  if (
    !selection ||
    typeof selection !== "object" ||
    Array.isArray(selection) ||
    typeof selection.path !== "string" ||
    !selection.path.trim() ||
    (selection.bookmark !== null && typeof selection.bookmark !== "string") ||
    typeof selection.updatedAt !== "string" ||
    Object.keys(selection).some(
      (key) => !["path", "bookmark", "updatedAt"].includes(key),
    )
  ) {
    throw new ElizaError("Invalid workspace selection", {
      code: "PROJECT_SELECTION_INVALID",
      context: { source },
    });
  }
  // Existing task bindings use this id; conversion must preserve it byte-for-byte.
  const id = `legacy-${createHash("sha256").update(selection.path).digest("hex").slice(0, 16)}`;
  const registry: ProjectRegistry = {
    version: 1,
    activeProjectId: id,
    projects: [
      {
        id,
        name: basename(selection.path),
        localPath: selection.path,
        bookmark: selection.bookmark,
        createdAt: selection.updatedAt,
        lastOpenedAt: selection.updatedAt,
      },
    ],
  };
  try {
    writeJsonFileAtomic(projectRegistryPath(env), registry, {
      createOnly: true,
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST")
      return readProjectRegistry(env);
    throw new ElizaError("Cannot import workspace selection", {
      code: "PROJECT_SELECTION_WRITE_FAILED",
      context: { source },
      cause,
    });
  }
  try {
    unlinkSync(source);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ElizaError("Cannot retire imported workspace selection", {
        code: "PROJECT_SELECTION_CLEANUP_FAILED",
        context: { source },
        cause,
      });
    }
  }
  return registry;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Realpath-canonicalize a localPath for identity: matches `project-binding.ts`,
 * which realpaths at compare time, so writing the canonical form here stops
 * `/tmp/x` and `/private/tmp/x` (macOS) from registering as two projects for the
 * same directory. Falls back to a resolved absolute path when the dir does not
 * exist yet — a project can be registered before its checkout is cloned.
 */
function canonicalizeLocalPath(localPath: string): string {
  const abs = resolve(localPath);
  try {
    return realpathSync(abs);
  } catch {
    // error-policy:J3 path may not exist yet (project registered pre-clone);
    // the resolved absolute form is still a stable identity key.
    return abs;
  }
}

/** Atomically replace valid state without downgrading newer schemas. */
export function writeProjectRegistry(
  registry: ProjectRegistry,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRegistry {
  const stored = readStoredRegistry(env);
  if (
    stored !== null &&
    typeof stored === "object" &&
    "version" in stored &&
    typeof stored.version === "number" &&
    stored.version > registry.version
  ) {
    throw new ElizaError(
      "Refusing to overwrite a newer project registry schema",
      {
        code: "PROJECT_REGISTRY_NEWER_SCHEMA",
        context: {
          onDiskVersion: stored.version,
          requestedVersion: registry.version,
        },
      },
    );
  }
  if (
    !isProjectRegistry(registry) ||
    (stored !== undefined && !isProjectRegistry(stored))
  ) {
    throw new ElizaError("Refusing to write an invalid project registry", {
      code: "PROJECT_REGISTRY_INVALID",
      context: { filePath: projectRegistryPath(env) },
    });
  }
  const filePath = projectRegistryPath(env);
  try {
    writeJsonFileAtomic(filePath, registry);
  } catch (cause) {
    throw new ElizaError("Cannot write project registry", {
      code: "PROJECT_REGISTRY_WRITE_FAILED",
      context: { filePath },
      cause,
    });
  }
  return registry;
}

function emptyRegistry(): ProjectRegistry {
  return { version: 1, activeProjectId: null, projects: [] };
}

/**
 * Insert or update a project keyed by `localPath` identity, persist, and return
 * the upserted record. An existing project's id/createdAt are preserved; the
 * supplied fields update the record. Set `activate` to select it atomically.
 */
export function upsertProject(
  input: Omit<ProjectRecord, "id" | "createdAt" | "lastOpenedAt"> &
    Partial<Pick<ProjectRecord, "id" | "createdAt" | "lastOpenedAt">>,
  env: NodeJS.ProcessEnv = process.env,
  options: { activate?: boolean } = {},
): ProjectRecord {
  const registry = readProjectRegistry(env) ?? emptyRegistry();
  const now = new Date().toISOString();
  // Canonicalize before matching AND storing so the same directory reached by
  // different path spellings (symlink, `/tmp` vs `/private/tmp`) upserts one
  // project, not a duplicate per spelling.
  const localPath = canonicalizeLocalPath(input.localPath);
  const existing = registry.projects.find(
    (p) =>
      canonicalizeLocalPath(p.localPath) === localPath ||
      (input.id && p.id === input.id),
  );
  const record: ProjectRecord = {
    id: existing?.id ?? input.id ?? randomUUID(),
    name: input.name,
    localPath,
    repoUrl: input.repoUrl ?? existing?.repoUrl,
    defaultBranch: input.defaultBranch ?? existing?.defaultBranch,
    worldId: input.worldId ?? existing?.worldId,
    bookmark:
      input.bookmark === undefined ? existing?.bookmark : input.bookmark,
    cloudAppId: input.cloudAppId ?? existing?.cloudAppId,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    lastOpenedAt: input.lastOpenedAt ?? now,
  };
  const projects = existing
    ? registry.projects.map((p) => (p.id === existing.id ? record : p))
    : [...registry.projects, record];
  writeProjectRegistry(
    {
      ...registry,
      projects,
      activeProjectId: options.activate ? record.id : registry.activeProjectId,
    },
    env,
  );
  return record;
}

/**
 * Mark a project active and stamp its `lastOpenedAt`. Returns the active record,
 * or `null` when the id is unknown (the registry is left unchanged).
 */
export function setActiveProject(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRecord | null {
  const registry = readProjectRegistry(env);
  if (!registry) return null;
  const target = registry.projects.find((p) => p.id === projectId);
  if (!target) return null;
  const now = new Date().toISOString();
  const projects = registry.projects.map((p) =>
    p.id === projectId ? { ...p, lastOpenedAt: now } : p,
  );
  writeProjectRegistry(
    { ...registry, activeProjectId: projectId, projects },
    env,
  );
  return { ...target, lastOpenedAt: now };
}

/** The active project, or `null` when the registry is absent/has no active id. */
export function getActiveProject(
  env: NodeJS.ProcessEnv = process.env,
): ProjectRecord | null {
  const registry = readProjectRegistry(env);
  if (!registry?.activeProjectId) return null;
  return (
    registry.projects.find((p) => p.id === registry.activeProjectId) ?? null
  );
}

/** Look up a project by id, or `null` when absent. */
export function getProjectById(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRecord | null {
  const registry = readProjectRegistry(env);
  return registry?.projects.find((p) => p.id === projectId) ?? null;
}

export function selectProjectFolder(
  localPath: string,
  bookmark: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRecord {
  if (!localPath.trim()) {
    throw new ElizaError("Workspace path is required", {
      code: "PROJECT_PATH_INVALID",
    });
  }
  const registry = readProjectRegistry(env);
  const bookmarked = bookmark
    ? registry?.projects.find((p) => p.bookmark === bookmark)
    : undefined;
  const located = registry?.projects.find(
    (p) =>
      canonicalizeLocalPath(p.localPath) === canonicalizeLocalPath(localPath),
  );
  if (bookmarked && located && bookmarked.id !== located.id) {
    throw new ElizaError(
      "Restored workspace conflicts with an existing project",
      {
        code: "PROJECT_PATH_CONFLICT",
      },
    );
  }
  const existing = bookmarked ?? located;
  return upsertProject(
    {
      id: existing?.id,
      name: existing?.name ?? basename(localPath),
      localPath,
      bookmark,
    },
    env,
    { activate: true },
  );
}

export function revokeProjectBookmark(
  bookmark: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const registry = readProjectRegistry(env);
  if (!registry?.projects.some((p) => p.bookmark === bookmark)) return;
  const revokedActive = registry.projects.some(
    (p) => p.id === registry.activeProjectId && p.bookmark === bookmark,
  );
  writeProjectRegistry(
    {
      ...registry,
      activeProjectId: revokedActive ? null : registry.activeProjectId,
      projects: registry.projects.map((p) =>
        p.bookmark === bookmark ? { ...p, bookmark: null } : p,
      ),
    },
    env,
  );
}
