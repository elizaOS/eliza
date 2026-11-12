/** Selects full, redacted, or omitted artifact metadata for the requester. Authorization applies to the referencing record; content-addressed URLs remain byte-access capabilities. Grants are additive and missing disclosure scope defaults to owner-private. */
import type { AccessContext } from "../types/access-context.js";
import type {
	ArtifactRoomSnapshot,
	ArtifactShareGrant,
	ArtifactShareMetadata,
	Memory,
	MemoryScope,
} from "../types/memory.js";
import type { UUID } from "../types/primitives.js";
import { validateUuid } from "../utils/uuid.js";
import { actorFromAccessContext, canReadScope } from "./filter";
import { isMemoryScope, parseShareGrantList } from "./memory-scope.js";

/** What a viewer's DTO may contain for one artifact. */
export type ArtifactDisclosure = "full" | "redacted" | "none";

/** Typed share metadata parsed from a record's jsonb metadata. */
export interface ParsedArtifactShareMetadata {
	grants: ArtifactShareGrant[];
	/** Room roster captured with a share so later disclosure can be replayed. */
	roomSnapshot?: ArtifactRoomSnapshot;
}

/**
 * Parse `metadata.share.grants` off an untyped stored record into typed
 * grants. Malformed entries are dropped — a grant that cannot be read grants
 * NOTHING (fail closed), it never degrades into some default access.
 */
// error-policy:J3 untrusted-input sanitizing — stored jsonb is untyped at rest;
// invalid grant entries yield an explicit empty result, never a fake grant.
export function parseArtifactShareMetadata(
	metadata: unknown,
): ParsedArtifactShareMetadata {
	if (!metadata || typeof metadata !== "object") return { grants: [] };
	const share = (metadata as { share?: unknown }).share;
	if (!share || typeof share !== "object") return { grants: [] };
	const grants = parseShareGrantList((share as { grants?: unknown }).grants);
	const roomSnapshot = parseArtifactShareRoomSnapshot(
		(share as { roomSnapshot?: unknown }).roomSnapshot,
	);
	return {
		grants,
		...(roomSnapshot ? { roomSnapshot } : {}),
	};
}

export function parseArtifactShareGrants(
	metadata: unknown,
): ArtifactShareGrant[] {
	return parseArtifactShareMetadata(metadata).grants;
}

function parseArtifactShareRoomSnapshot(
	value: unknown,
): ArtifactRoomSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const snapshot = value as Record<string, unknown>;
	const roomId = validateUuid(snapshot.roomId);
	if (!roomId) return undefined;
	const atMs = snapshot.atMs;
	if (typeof atMs !== "number") return undefined;
	const entityIds = snapshot.entityIds;
	if (!Array.isArray(entityIds)) return undefined;
	if (!entityIds.every((entityId) => validateUuid(entityId) !== null)) {
		return undefined;
	}
	return {
		roomId,
		entityIds: entityIds as UUID[],
		atMs,
	};
}

/** The disclosure-relevant fields of one artifact-referencing record. */
export interface ArtifactDisclosureRecord {
	/** Stored visibility scope (callers normalize; unknown fails closed). */
	scope: MemoryScope;
	/** Entity the record is scoped to (owner/speaker), for entity-scoped tiers. */
	scopedEntityId?: UUID;
	/** Parsed share grants from the record's metadata. */
	grants?: readonly ArtifactShareGrant[];
	/** Full typed share metadata when callers already carry the parsed contract. */
	share?: ParsedArtifactShareMetadata | ArtifactShareMetadata;
}

/**
 * Normalize one stored memory into the artifact-disclosure record shape.
 *
 * Storage metadata is jsonb and therefore untrusted at read time. Unknown scope
 * values collapse to `owner-private`, and malformed grants/scoped ids are
 * ignored, so a corrupt row cannot widen disclosure by accident.
 */
export function artifactDisclosureRecordFromMemory(
	memory: Pick<Memory, "entityId" | "metadata">,
): ArtifactDisclosureRecord {
	const metadata =
		memory.metadata && typeof memory.metadata === "object"
			? (memory.metadata as Record<string, unknown>)
			: undefined;
	const scopedEntityId =
		validateUuid(metadata?.scopedToEntityId) ??
		validateUuid(metadata?.addedBy) ??
		memory.entityId;
	const scope = metadata?.scope;
	return {
		scope: isMemoryScope(scope) ? scope : "owner-private",
		...(scopedEntityId ? { scopedEntityId } : {}),
		grants: parseArtifactShareGrants(metadata),
	};
}

/**
 * Decide what `ctx`'s requester may see of one artifact record.
 *
 * Tier order (most privileged first):
 * 1. No access context → `full`. The single-owner local boundary deliberately
 * omits a context (see `RouteHandlerContext.accessContext`), and existing
 * unfiltered behavior there is a documented product decision.
 * 2. Agent self-read, OWNER, or ADMIN rank → `full`.
 * 3. An explicit per-entity grant wins in BOTH directions: a `full` grant
 * elevates past the scope ladder, and a `redacted` grant narrows the viewer
 * to the variant even when the scope ladder would allow full — the owner's
 * per-viewer instruction (e.g. an admin "redact for everyone" pass) must
 * not be undone by a coarse `global` scope.
 * 4. No grant → the scope ladder (`canReadScope`): a USER still reads global
 * records and their own user-private records in full; the `owner-private`
 * default fails closed to `none`.
 */
export function resolveArtifactDisclosure(
	record: ArtifactDisclosureRecord,
	ctx: AccessContext | undefined,
	agentId: UUID,
): ArtifactDisclosure {
	if (!ctx) return "full";
	if (ctx.requesterEntityId === agentId) return "full";
	const actor = actorFromAccessContext(ctx, agentId);
	// Tier 2 is OWNER/ADMIN only. Every other actor — USER, GUEST, RUNTIME, or
	// an UNRESOLVED authority — must fall through to the grant check and the
	// scope ladder below: treating "not USER" as elevated here hands
	// least-privileged viewers tier-2 `full` disclosure and inverts the
	// fail-closed matrix this module documents.
	if (actor.role === "OWNER" || actor.role === "ADMIN") return "full";
	const grants = record.grants ?? record.share?.grants;
	const grant = grants?.find((g) => g.entityId === ctx.requesterEntityId);
	if (grant) return grant.mode === "full" ? "full" : "redacted";
	// Tier 4: absent role authority may preserve open room/global disclosure,
	// but it must never inherit USER's entity-self exception for private data.
	// Mapping UNRESOLVED to USER without this private-scope fence lets a bare
	// requester context read its own `user-private` artifact despite having no
	// resolved authorization state.
	if (
		actor.role === "UNRESOLVED" &&
		record.scope !== "global" &&
		record.scope !== "shared" &&
		record.scope !== "room"
	) {
		return "none";
	}
	const ladderActor =
		actor.role === "UNRESOLVED" ? { ...actor, role: "USER" as const } : actor;
	return canReadScope(record.scope, record.scopedEntityId, ladderActor)
		? "full"
		: "none";
}

export interface ArtifactVariantUrls {
	fullUrl?: string | null;
	redactedUrl?: string | null;
}

export interface DisclosedArtifactUrl {
	disclosure: Exclude<ArtifactDisclosure, "none">;
	url: string;
	redacted: boolean;
}

/**
 * Select the URL a DTO may disclose for a resolved artifact decision.
 *
 * A redacted grant is fail-closed: if no redacted variant exists yet, callers
 * must omit the artifact instead of falling back to the original bytes.
 */
export function selectDisclosedArtifactUrl(
	disclosure: ArtifactDisclosure,
	urls: ArtifactVariantUrls,
): DisclosedArtifactUrl | null {
	if (disclosure === "none") return null;
	if (disclosure === "redacted") {
		return typeof urls.redactedUrl === "string" && urls.redactedUrl.length > 0
			? { disclosure, url: urls.redactedUrl, redacted: true }
			: null;
	}
	return typeof urls.fullUrl === "string" && urls.fullUrl.length > 0
		? { disclosure, url: urls.fullUrl, redacted: false }
		: null;
}
