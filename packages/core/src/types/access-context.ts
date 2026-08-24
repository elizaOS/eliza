/**
 * Access-control context threaded through memory reads: identifies the requester
 * a retrieval runs on behalf of so a database adapter can intersect world,
 * authorized rooms, and disclosure scope before pagination. Part of the
 * canonical `@elizaos/core` type system; enforcement composes with the opt-in
 * Postgres RLS in `plugin-sql` and is a no-op when omitted (single-tenant reads
 * stay unfiltered).
 */
import type { RoleName } from "../roles";
import type { UUID } from "./primitives";

/**
 * Identity of the requester a memory read runs on behalf of, used to filter
 * retrieval down to what that requester is permitted to see.
 *
 * Threading an `AccessContext` is always optional: when a read omits it, the
 * adapter applies no access-context filtering — i.e. today's single-tenant
 * behavior is preserved byte-for-byte. Enforcement composes with (and never
 * duplicates) the opt-in Postgres RLS in `plugin-sql`.
 */
export interface AccessContext {
	/**
	 * Entity the read runs for — the speaker/requester (`Memory.entityId`). For
	 * agent-scoped reads pass `runtime.agentId` explicitly; never leave it unset
	 * to mean "everything", which would silently read unfiltered.
	 */
	requesterEntityId: UUID;
	/** World/tenant the request is scoped to. */
	worldId?: UUID;
	/**
	 * Rooms whose membership/containment has already been authorized for this
	 * read. When present, adapters intersect every memory query with this set and
	 * with `worldId` (when supplied) before ordering, ranking, or pagination; an
	 * empty set therefore denies all room-backed memories. Omission preserves the
	 * legacy scope-only contract for callers that have not yet resolved room
	 * authority, so topology-aware callers must never omit it accidentally.
	 */
	authorizedRoomIds?: readonly UUID[];
	/** Requester's resolved role within `worldId`. */
	role?: RoleName;
	/** Whether the requester owns `worldId`. */
	isOwner?: boolean;
	/** Connector provenance of the requester (e.g. `discord`, `slack`). */
	source?: string;
}
