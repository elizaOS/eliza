/**
 * Per-project memory scoping (issue #13776 item 4, design D3).
 *
 * A Project (see `project-registry.ts`) partitions an agent's memories by
 * mapping each project to a dedicated `worldId`, so an agent working in project
 * A never retrieves project B's memories. This is the worldId-mapping approach
 * decided in D3 (no memory schema change): `Memory.worldId` already exists and
 * `getMemories`/`searchMemories` already filter by it, so partitioning a
 * project's task-room memories under a project-derived world gives isolation
 * "for free" at the store layer.
 *
 * This module owns the *deterministic mapping* and the *scoping guards* that
 * sit above the database interface:
 *
 *   - `projectWorldId(agentId, projectId)` — the stable, per-agent worldId for a
 *     project. Mirrors `createUniqueUuid`'s derivation (`"<base>:<agentId>"`) so
 *     the value is identical to what a runtime helper would produce, without
 *     needing a full runtime instance in the store/test layer.
 *   - `scopeMemoryFilterToProject(filter, opts)` — inject the project worldId
 *     into a read/search filter. **No projectId ⇒ filter returned unchanged**
 *     (unscoped/global reads — today's behavior, backward compatible). A
 *     conflicting caller-supplied `worldId` is a programmer error and throws.
 *   - `scopeMemoryToProject(memory, opts)` — stamp the project worldId on a
 *     memory at write time. No projectId ⇒ memory unchanged (global write).
 *   - `assertMemoriesInProject(memories, opts)` — fail-closed retrieval guard:
 *     when a projectId IS set, any returned memory that carries a *different*
 *     project world is a cross-project leak and throws, rather than silently
 *     returning another project's data. Legacy memories with no `worldId` are
 *     allowed through (they predate scoping and are global by definition).
 *
 * Backward compatibility contract (verified by tests):
 *   - projectId omitted anywhere ⇒ zero behavior change (global semantics).
 *   - legacy memories without a worldId remain retrievable under an unscoped
 *     read, and are NOT treated as a cross-project leak under a scoped read.
 */

import { ElizaError } from "../errors.ts";
import type { UUID } from "../types/primitives.ts";
import { stringToUuid } from "../utils.ts";

/**
 * Prefix for the project→world derivation. Kept distinct so a project id can
 * never collide with an entity/room base used elsewhere in `createUniqueUuid`.
 */
export const PROJECT_WORLD_PREFIX = "project:";

function projectMemoryScopeError(
	message: string,
	code: string,
	context: Record<string, unknown>,
): ElizaError {
	return new ElizaError(message, {
		code,
		context,
		severity: "fatal",
	});
}

function normalizeProjectId(projectId: string | undefined): string | undefined {
	const trimmed = projectId?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Deterministic, per-agent worldId for a project.
 *
 * Derivation matches `createUniqueUuid(runtime, "project:" + projectId)`:
 * `stringToUuid("project:<projectId>:<agentId>")`. Per-agent because Worlds are
 * agent-scoped (`World.agentId`); two agents referencing the same project each
 * get their own project world, exactly like every other `createUniqueUuid`
 * value.
 *
 * @param agentId  the runtime's agentId (worlds are agent-scoped)
 * @param projectId the ProjectRecord id
 * @returns stable worldId UUID for (agent, project)
 */
export function projectWorldId(agentId: UUID, projectId: string): UUID {
	const normalizedProjectId = normalizeProjectId(projectId);
	if (!normalizedProjectId) {
		throw projectMemoryScopeError(
			"projectWorldId: projectId must be a non-empty string",
			"PROJECT_MEMORY_SCOPE_INVALID_PROJECT_ID",
			{ projectId },
		);
	}
	if (!agentId || (agentId as string).length === 0) {
		throw projectMemoryScopeError(
			"projectWorldId: agentId must be a non-empty UUID",
			"PROJECT_MEMORY_SCOPE_INVALID_AGENT_ID",
			{ agentId },
		);
	}
	const base = `${PROJECT_WORLD_PREFIX}${normalizedProjectId}`;
	// Mirror createUniqueUuid: `${baseUserId}:${runtime.agentId}`.
	return stringToUuid(`${base}:${agentId}`);
}

/** Options shared by the scoping helpers. */
export interface ProjectScopeOptions {
	/** The runtime agentId (worlds are agent-scoped). Required to derive a world. */
	agentId: UUID;
	/**
	 * The active project id. **Omitted/empty ⇒ no scoping** (global/unscoped
	 * behavior, backward compatible). This is the single switch for the whole
	 * feature: absence means "behave exactly like before".
	 */
	projectId?: string;
}

/**
 * A minimal read/search filter shape carrying an optional `worldId`. Matches the
 * relevant subset of the `getMemories`/`searchMemories` param objects so this
 * helper can wrap either without importing the full DB interface.
 */
export interface WorldScopedFilter {
	worldId?: UUID;
	[key: string]: unknown;
}

/**
 * Inject the project worldId into a memory read/search filter.
 *
 * - No `projectId` ⇒ returns the filter **unchanged** (unscoped/global read).
 * - `projectId` set ⇒ returns a copy with `worldId` set to the project world.
 * - If the caller already set a `worldId` that DISAGREES with the project world
 *   while a projectId is in effect, that is a fail-closed error (a caller trying
 *   to read one project's memories under another project's scope). A matching
 *   worldId is a no-op.
 */
export function scopeMemoryFilterToProject<T extends WorldScopedFilter>(
	filter: T,
	opts: ProjectScopeOptions,
): T {
	const projectId = normalizeProjectId(opts.projectId);
	if (!projectId) return filter;
	const worldId = projectWorldId(opts.agentId, projectId);
	if (filter.worldId !== undefined && filter.worldId !== worldId) {
		throw projectMemoryScopeError(
			`scopeMemoryFilterToProject: filter.worldId (${filter.worldId}) conflicts with active project world (${worldId}); refusing cross-project read`,
			"PROJECT_MEMORY_SCOPE_FILTER_WORLD_CONFLICT",
			{
				agentId: opts.agentId,
				projectId,
				filterWorldId: filter.worldId,
				projectWorldId: worldId,
			},
		);
	}
	return { ...filter, worldId };
}

/**
 * A minimal memory shape carrying an optional `worldId`. Matches the subset of
 * `Memory` needed here without importing the full type (avoids a cycle for
 * store-layer callers).
 */
export interface WorldScopedMemory {
	worldId?: UUID;
	[key: string]: unknown;
}

/**
 * Stamp the project worldId on a memory at write time.
 *
 * - No `projectId` ⇒ returns the memory **unchanged** (global write).
 * - `projectId` set ⇒ returns a copy with `worldId` set to the project world.
 * - A pre-existing conflicting `worldId` on the memory (while a project is in
 *   effect) is a fail-closed error: writing a memory tagged for project B while
 *   scoped to project A would poison isolation. A matching worldId is a no-op.
 */
export function scopeMemoryToProject<T extends WorldScopedMemory>(
	memory: T,
	opts: ProjectScopeOptions,
): T {
	const projectId = normalizeProjectId(opts.projectId);
	if (!projectId) return memory;
	const worldId = projectWorldId(opts.agentId, projectId);
	if (memory.worldId !== undefined && memory.worldId !== worldId) {
		throw projectMemoryScopeError(
			`scopeMemoryToProject: memory.worldId (${memory.worldId}) conflicts with active project world (${worldId}); refusing to write cross-project memory`,
			"PROJECT_MEMORY_SCOPE_MEMORY_WORLD_CONFLICT",
			{
				agentId: opts.agentId,
				projectId,
				memoryWorldId: memory.worldId,
				projectWorldId: worldId,
			},
		);
	}
	return { ...memory, worldId };
}

/**
 * Fail-closed retrieval guard. When a `projectId` is set, assert that every
 * returned memory belongs to the active project's world (or is a legacy
 * unscoped memory with no worldId). A memory carrying a *different* worldId is a
 * cross-project leak and throws rather than being returned.
 *
 * - No `projectId` ⇒ returns the memories unchanged (unscoped read, no guard).
 * - Legacy memories (`worldId === undefined`) are allowed: they predate scoping
 *   and are global by definition; excluding them would break existing agents.
 * - A memory whose `worldId` equals the project world is allowed.
 * - Any other `worldId` throws.
 *
 * Store-layer filtering (`getMemories({ worldId })`) already prevents most
 * cross-project rows from being fetched; this is the defense-in-depth assertion
 * for paths that bypass or predate the filter (e.g. id-batch fetches).
 */
export function assertMemoriesInProject<T extends WorldScopedMemory>(
	memories: readonly T[],
	opts: ProjectScopeOptions,
): readonly T[] {
	const projectId = normalizeProjectId(opts.projectId);
	if (!projectId) return memories;
	const worldId = projectWorldId(opts.agentId, projectId);
	for (const memory of memories) {
		if (memory.worldId === undefined) continue; // legacy global memory
		if (memory.worldId !== worldId) {
			throw projectMemoryScopeError(
				`assertMemoriesInProject: retrieved memory in world ${memory.worldId} does not belong to active project world ${worldId}; refusing cross-project leak`,
				"PROJECT_MEMORY_SCOPE_RETRIEVED_WORLD_CONFLICT",
				{
					agentId: opts.agentId,
					projectId,
					memoryWorldId: memory.worldId,
					projectWorldId: worldId,
				},
			);
		}
	}
	return memories;
}
