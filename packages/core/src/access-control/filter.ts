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
import type { AccessContext, MemoryScope, UUID } from "../types";

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

function isMemoryScope(value: unknown): value is MemoryScope {
	switch (value) {
		case "shared":
		case "private":
		case "room":
		case "global":
		case "owner-private":
		case "user-private":
		case "agent-private":
			return true;
		default:
			return false;
	}
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

/**
 * Filter retrieval records down to the disclosure scopes `ctx`'s requester may
 * read. A pure, strictly subtractive `.filter()` that composes with (never
 * duplicates) Postgres RLS and with the adapter-bound location filter below.
 * An ABSENT scope fails CLOSED to `private` (author-scoped):
 * an unstamped legacy row must never be treated as globally readable, because
 * a write path that forgot to stamp a scope would otherwise silently publish
 * private data to every actor. `private` (rather than `owner-private`) keeps
 * the author's own rows and the agent's self-recall working on legacy
 * unstamped data while still denying strangers. Malformed scopes also fail
 * closed. The owning entity is taken from `metadata.scopedToEntityId`, else
 * `metadata.addedBy`, else `entityId` (mirroring the documents plugin).
 */
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
		// Fail closed: no stamp = `private` (author-scoped), never `global`. The
		// author (via the scopedToEntityId -> addedBy -> entityId resolution
		// below), the agent, and the runtime can still read an unstamped row;
		// strangers (USER/GUEST/unresolved) cannot. This deliberately DIVERGES
		// from normalizeScope (artifact-disclosure.ts), which defaults absent
		// scopes to owner-private: artifacts have no agent-self-recall
		// requirement, but messages do — legacy unstamped message rows must stay
		// readable to their author and to the agent, or recall silently breaks.
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

/**
 * Adapter-bound memory filter. Unlike {@link filterByAccessContext}, which is
 * also used after explicitly authorized cross-world recall, this variant
 * treats `worldId` and `authorizedRoomIds` as storage-query intersections and
 * rejects rows stamped for another agent. Adapters call it before any
 * ordering, ranking, cursor, offset, or limit operation. Message-table callers
 * with an explicit authorized-room set may pass `room` for `unstampedScope`:
 * legacy transcript rows predate disclosure stamps, and verified room
 * membership is their read boundary. Other tables retain author-private
 * fail-closed behavior.
 */
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
