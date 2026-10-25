/**
 * Read-side access-control filters for memory-shaped retrieval records: the
 * general disclosure filter applies the scope ladder, while the adapter-bound
 * variant additionally intersects agent, world, and authorized-room bounds
 * before ordering, ranking, or pagination.
 *
 * Composes with — never duplicates — Postgres RLS: RLS gates on
 * `entity_id`/`server_id`, this gates on `metadata.scope`. For the four
 * document scopes the ladder is byte-identical to the documents plugin's
 * `canReadDocumentMemory`, so that plugin can delegate here without behavior
 * change; keep the two in lockstep. An unresolved role fails closed to the
 * least-privileged `USER` tier.
 */

import type { RoleName } from "../roles";
import type { AccessContext } from "../types/access-context.js";
import type { MemoryScope } from "../types/memory.js";
import type { UUID } from "../types/primitives.js";
import { isMemoryScope } from "./memory-scope.js";

interface AccessScopedRecord {
	agentId?: UUID;
	entityId?: UUID;
	roomId?: UUID;
	worldId?: UUID;
	metadata?: {
		scope?: unknown;
		scopedToEntityId?: unknown;
		addedBy?: unknown;
	};
}

/**
 * Read-side actor role: the core {@link RoleName} widened with the machine
 * tiers the scope ladder recognizes — `AGENT` (an agent reading its own store)
 * and `RUNTIME` (the documents read path that delegates to this ladder).
 * {@link actorFromAccessContext} preserves explicit human roles, yields `AGENT`
 * for self-read, and uses `UNRESOLVED` when authority is absent. `RUNTIME` is
 * supplied by trusted internal callers, never minted from a message.
 */
export type ActorRole = RoleName | "AGENT" | "RUNTIME" | "UNRESOLVED";

export interface ScopeActor {
	entityId: UUID;
	role: ActorRole;
}

/**
 * Collapse an {@link AccessContext} into the scope-ladder actor. A self-read
 * (requester is the agent) is `AGENT`; every explicit role remains distinct.
 * Missing role authority becomes `UNRESOLVED`, which every scope denies.
 */
export function actorFromAccessContext(
	ctx: AccessContext,
	agentId: UUID,
): ScopeActor {
	if (ctx.requesterEntityId === agentId) {
		return { entityId: agentId, role: "AGENT" };
	}
	if (ctx.isOwner || ctx.role === "OWNER") {
		return { entityId: ctx.requesterEntityId, role: "OWNER" };
	}
	switch (ctx.role) {
		case "ADMIN":
		case "USER":
		case "GUEST":
			return { entityId: ctx.requesterEntityId, role: ctx.role };
		default:
			return { entityId: ctx.requesterEntityId, role: "UNRESOLVED" };
	}
}

/**
 * Whether `actor` may read a memory of the given `scope`. For the four document
 * scopes this is byte-equivalent to the documents plugin's `canReadDocumentMemory`
 * so that plugin can delegate here without changing behavior. The generic core
 * scopes fold in: `shared`/`room` read like `global`, `private` like
 * `user-private`. `scopedEntityId` is the memory's owning entity (used only by
 * the entity-scoped tiers); `opts.scopedToEntityId` lets an OWNER read on behalf
 * of a specific entity, matching the documents filter.
 */
export function canReadScope(
	scope: MemoryScope,
	scopedEntityId: UUID | undefined,
	actor: ScopeActor,
	opts?: { scopedToEntityId?: UUID },
): boolean {
	if (actor.role === "UNRESOLVED") return false;
	switch (scope) {
		case "global":
		case "shared":
		case "room":
			return true;
		case "owner-private":
			return actor.role === "OWNER" || actor.role === "RUNTIME";
		case "agent-private":
			return (
				actor.role === "OWNER" ||
				actor.role === "AGENT" ||
				actor.role === "RUNTIME"
			);
		case "user-private":
		case "private": {
			if (!scopedEntityId) return false;
			if (actor.role === "GUEST") return false;
			if (actor.role === "AGENT" || actor.role === "RUNTIME") return true;
			if (actor.role === "OWNER") {
				return opts?.scopedToEntityId
					? scopedEntityId === opts.scopedToEntityId
					: scopedEntityId === actor.entityId;
			}
			return scopedEntityId === actor.entityId;
		}
	}
}

/** Filters records by requester disclosure authority, in addition to storage RLS. Missing or malformed scope is author-private. Ownership resolves from scopedToEntityId, addedBy, then entityId. */
export function filterByAccessContext<T extends AccessScopedRecord>(
	memories: T[],
	ctx: AccessContext,
	agentId: UUID,
): T[] {
	const actor = actorFromAccessContext(ctx, agentId);
	return memories.filter((memory) => {
		const rawScope = memory.metadata?.scope;
		if (rawScope !== undefined && !isMemoryScope(rawScope)) {
			return false;
		}
		// Unstamped messages default to author-private so the author and agent can recall them
		// without exposing them to other requesters.
		const scope = rawScope ?? "private";
		const meta = memory.metadata;
		const scopedTo = meta?.scopedToEntityId;
		const addedBy = meta?.addedBy;
		const scopedEntityId =
			typeof scopedTo === "string"
				? (scopedTo as UUID)
				: typeof addedBy === "string"
					? (addedBy as UUID)
					: memory.entityId;
		return canReadScope(scope, scopedEntityId, actor);
	});
}

/** Applies agent, world, and authorized-room intersections before ranking or pagination. Message queries with verified room membership may use room scope for unstamped rows; other queries default to author-private. */
export function filterMemoryReadByAccessContext<T extends AccessScopedRecord>(
	memories: T[],
	ctx: AccessContext,
	agentId: UUID,
	unstampedScope: MemoryScope = "private",
): T[] {
	const authorizedRoomIds =
		ctx.authorizedRoomIds === undefined
			? undefined
			: new Set<UUID>(ctx.authorizedRoomIds);
	const located = memories.filter((memory) => {
		if (memory.agentId !== undefined && memory.agentId !== agentId)
			return false;
		if (authorizedRoomIds === undefined) return true;
		if (ctx.worldId !== undefined && memory.worldId !== ctx.worldId)
			return false;
		return memory.roomId !== undefined && authorizedRoomIds.has(memory.roomId);
	});
	if (unstampedScope === "private") {
		return filterByAccessContext(located, ctx, agentId);
	}
	return filterByAccessContext(
		located.map((memory) =>
			memory.metadata?.scope === undefined
				? {
						...memory,
						metadata: { ...memory.metadata, scope: unstampedScope },
					}
				: memory,
		),
		ctx,
		agentId,
	) as T[];
}
