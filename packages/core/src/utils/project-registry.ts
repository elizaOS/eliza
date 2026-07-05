/**
 * Project registry persisted in `<stateDir>/projects.json`.
 *
 * A Project is a named, durable binding to a local working directory (and, when
 * known, its git remote/branch): the first-class replacement for the single
 * global workspace-folder config (`workspace-folder-config.ts`), which handled
 * only the degenerate one-project case and got overwritten on every re-pick.
 *
 * Storage is a JSON file rather than a DB table on purpose: workspace resolution
 * runs at module-import time (`workspace-resolution.ts`) before any DB exists,
 * and the Electrobun renderer writes the active project cross-process pre-boot.
 * A file in the shared per-user state dir is the only bridge both sides can see.
 * This mirrors `workspace-folder-config.ts` in shape and atomic-write style.
 *
 * `localPath` is the identity key for a project (realpath-compared against a
 * task's resolved workdir to bind it). `cloudAppId` is reserved but never
 * auto-populated here — that relation is an owner decision (epic #13766 WS4).
 * The VFS `projectId` (`virtual-filesystem.ts`) is a separate workbench-sandbox
 * namespace and is intentionally unrelated to a ProjectRecord id.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDir } from "./state-dir.ts";
import { readWorkspaceFolderConfig } from "./workspace-folder-config.ts";

export interface ProjectRecord {
	id: string;
	name: string;
	/** Realpath-resolved local working directory. The project's identity key. */
	localPath: string;
	repoUrl?: string;
	defaultBranch?: string;
	/** macOS security-scoped bookmark for the picked folder, when present. */
	bookmark?: string | null;
	/** Reserved for the task↔Cloud-app relation; never auto-populated (#13766 WS4). */
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

/**
 * Read the registry, returning `null` when absent or malformed. When no
 * `projects.json` exists but a legacy `workspace-folder.json` does, synthesize a
 * single in-memory active project from it so callers migrating off the old
 * single-folder config keep working — WITHOUT writing the file (a write on read
 * would race the renderer and mint an id the renderer never chose).
 */
export function readProjectRegistry(
	env: NodeJS.ProcessEnv = process.env,
): ProjectRegistry | null {
	const filePath = projectRegistryPath(env);
	let raw: string | undefined;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		// error-policy:J4 registry file absent on first run — degrade to the
		// legacy workspace-folder.json (synthesized below) or no registry.
		raw = undefined;
	}
	if (raw !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// error-policy:J3 corrupt registry JSON → treat as absent, never a
			// fabricated empty registry that would silently drop the user's projects.
			return null;
		}
		return isProjectRegistry(parsed) ? parsed : null;
	}
	return synthesizeFromLegacyWorkspaceFolder(env);
}

/**
 * Deterministic id for the project synthesized from the legacy
 * workspace-folder.json. The synthesized registry is re-minted on every read
 * (reads never write), so a random id would differ between reads: a task bound
 * during the migration window would persist a projectId that no later
 * `getProjectById` could ever resolve, silently disabling the bound-workdir
 * lock (#13776). Hashing the localPath keeps the id stable across reads, and
 * because `upsertProject` keys by localPath and preserves an existing id, the
 * first real write to projects.json persists this same id — so migration-window
 * task bindings survive the switch off the legacy config.
 */
function legacyProjectId(localPath: string): string {
	const digest = createHash("sha256").update(localPath).digest("hex");
	return `legacy-${digest.slice(0, 16)}`;
}

function synthesizeFromLegacyWorkspaceFolder(
	env: NodeJS.ProcessEnv,
): ProjectRegistry | null {
	const legacy = readWorkspaceFolderConfig(env);
	if (!legacy?.path?.trim()) return null;
	const now = legacy.updatedAt ?? new Date().toISOString();
	const project: ProjectRecord = {
		id: legacyProjectId(legacy.path),
		name: basename(legacy.path),
		localPath: legacy.path,
		bookmark: legacy.bookmark,
		createdAt: now,
		lastOpenedAt: now,
	};
	return { version: 1, activeProjectId: project.id, projects: [project] };
}

function basename(p: string): string {
	const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
	return parts[parts.length - 1] || p;
}

/** Atomic write: same tmp-file-then-rename pattern as workspace-folder-config. */
export function writeProjectRegistry(
	registry: ProjectRegistry,
	env: NodeJS.ProcessEnv = process.env,
): ProjectRegistry {
	const filePath = projectRegistryPath(env);
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
	renameSync(tmpPath, filePath);
	return registry;
}

function emptyRegistry(): ProjectRegistry {
	return { version: 1, activeProjectId: null, projects: [] };
}

/**
 * Insert or update a project keyed by `localPath` identity, persist, and return
 * the upserted record. An existing project's id/createdAt are preserved; the
 * caller's other fields overwrite. Does NOT change the active project — call
 * {@link setActiveProject} for that.
 */
export function upsertProject(
	input: Omit<ProjectRecord, "id" | "createdAt" | "lastOpenedAt"> &
		Partial<Pick<ProjectRecord, "id" | "createdAt" | "lastOpenedAt">>,
	env: NodeJS.ProcessEnv = process.env,
): ProjectRecord {
	const registry = readProjectRegistry(env) ?? emptyRegistry();
	const now = new Date().toISOString();
	const existing = registry.projects.find(
		(p) => p.localPath === input.localPath || (input.id && p.id === input.id),
	);
	const record: ProjectRecord = {
		id: existing?.id ?? input.id ?? randomUUID(),
		name: input.name,
		localPath: input.localPath,
		repoUrl: input.repoUrl,
		defaultBranch: input.defaultBranch,
		bookmark: input.bookmark,
		cloudAppId: input.cloudAppId,
		createdAt: existing?.createdAt ?? input.createdAt ?? now,
		lastOpenedAt: input.lastOpenedAt ?? now,
	};
	const projects = existing
		? registry.projects.map((p) => (p.id === existing.id ? record : p))
		: [...registry.projects, record];
	writeProjectRegistry({ ...registry, projects }, env);
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
