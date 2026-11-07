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

/** Requester authority for memory reads. Omission disables access-context filtering; adapter RLS remains a separate boundary. */
export interface AccessContext {
	/**
	 * Entity the read runs for — the speaker/requester (`Memory.entityId`). For
	 * agent-scoped reads pass `runtime.agentId` explicitly; never leave it unset
	 * to mean "everything", which would silently read unfiltered.
	 */
	requesterEntityId: UUID;
	/** World/tenant the request is scoped to. */
	worldId?: UUID;
	/** Authorized room intersection applied before ranking or pagination. Empty denies room-backed records; omission applies scope-only filtering. Topology-aware callers must supply the verified set. */
	authorizedRoomIds?: readonly UUID[];
	/** Requester's resolved role within `worldId`. */
	role?: RoleName;
	/** Whether the requester owns `worldId`. */
	isOwner?: boolean;
	/** Connector provenance of the requester (e.g. `discord`, `slack`). */
	source?: string;
}
