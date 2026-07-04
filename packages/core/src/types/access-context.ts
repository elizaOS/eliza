/**
 * Access-control context threaded through memory reads: identifies the requester
 * a retrieval runs on behalf of so a database adapter can filter results down to
 * what that requester is permitted to see. Part of the canonical `@elizaos/core`
 * type system; enforcement composes with the opt-in Postgres RLS in `plugin-sql`
 * and is a no-op when omitted (single-tenant reads stay unfiltered).
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
	/** Requester's resolved role within `worldId`. */
	role?: RoleName;
	/** Whether the requester owns `worldId`. */
	isOwner?: boolean;
	/** Connector provenance of the requester (e.g. `discord`, `slack`). */
	source?: string;
}
