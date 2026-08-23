/**
 * Role-aware artifact disclosure decision for shared artifacts (transcripts,
 * stored files, chat attachments, meeting sessions) — the read-side selector
 * behind #14778, designed inside the #8876 attachments doctrine: bytes stay on
 * the pre-auth content-addressed store (the sha256 URL is the capability), so
 * "permission" here means URL/DTO disclosure on the REFERENCING record, never
 * a byte-serve gate. Redacted variants are separate records/media objects; this
 * module only decides which variant a viewer's DTO may reference.
 *
 * One decision, three outcomes: `full` (emit the artifact as stored),
 * `redacted` (emit the redacted-variant fields, flagged), `none` (omit the row
 * entirely). Every disclosure surface routes through this single function so
 * the role matrix — OWNER/ADMIN/agent-self full; USER grant-driven; ungranted
 * viewers fall back to the scope ladder (which fails closed on the
 * `owner-private` default) — cannot drift per surface.
 *
 * Grants ride additively on the referencing record's metadata
 * (`metadata.share.grants`, jsonb — no migration, no sha256-keyed table per
 * doctrine AD1). The grant WRITE path (share actions, room-snapshot capture)
 * belongs to the PERM-ACL/PERM-REDACT children of #14749; this module only
 * evaluates what is stored. Default-matrix ratification is tracked in #14777 —
 * revisit the ordering below if D4/D5 land differently.
 */
import type {
	AccessContext,
	ArtifactRoomSnapshot,
	ArtifactShareGrant,
	ArtifactShareGrantMode,
	ArtifactShareMetadata,
	Memory,
	MemoryScope,
	UUID,
} from "../types";
import { actorFromAccessContext, canReadScope } from "./filter";

/** What a viewer's DTO may contain for one artifact. */
export type ArtifactDisclosure = "full" | "redacted" | "none";

export type {
	ArtifactRoomSnapshot,
	ArtifactShareGrant,
	ArtifactShareGrantMode,
	ArtifactShareMetadata,
};

/** Full and redacted artifact references carried by a DTO-capable record. */
export interface ArtifactVariantReferences<TFull, TRedacted = TFull> {
	full: TFull;
	redacted?: TRedacted | null;
}

/** The concrete reference a disclosure DTO should emit. */
export interface ResolvedArtifactVariant<T> {
	disclosure: Exclude<ArtifactDisclosure, "none">;
	value: T;
}

/** Room roster captured with a share so later disclosure can be replayed. */
export type ArtifactShareRoomSnapshot = ArtifactRoomSnapshot;

/** Typed share metadata parsed from a record's jsonb metadata. */
export interface ParsedArtifactShareMetadata {
	grants: ArtifactShareGrant[];
	roomSnapshot?: ArtifactShareRoomSnapshot;
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
	const grants = (share as { grants?: unknown }).grants;
	const out: ArtifactShareGrant[] = [];
	if (Array.isArray(grants)) {
		for (const entry of grants) {
			if (!entry || typeof entry !== "object") continue;
			const g = entry as Record<string, unknown>;
			const entityId = typeof g.entityId === "string" ? g.entityId : "";
			const mode = g.mode;
			if (!UUID_PATTERN.test(entityId)) continue;
			if (mode !== "full" && mode !== "redacted") continue;
			out.push({
				entityId: entityId as UUID,
				mode,
				...(typeof g.grantedBy === "string" && UUID_PATTERN.test(g.grantedBy)
					? { grantedBy: g.grantedBy as UUID }
					: {}),
				...(typeof g.grantedAtMs === "number"
					? { grantedAtMs: g.grantedAtMs }
					: {}),
			});
		}
	}
	const roomSnapshot = parseArtifactShareRoomSnapshot(
		(share as { roomSnapshot?: unknown }).roomSnapshot,
	);
	return {
		grants: out,
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
): ArtifactShareRoomSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const snapshot = value as Record<string, unknown>;
	const roomId = typeof snapshot.roomId === "string" ? snapshot.roomId : "";
	if (!UUID_PATTERN.test(roomId)) return undefined;
	const atMs = snapshot.atMs;
	if (typeof atMs !== "number") return undefined;
	const entityIds = snapshot.entityIds;
	if (!Array.isArray(entityIds)) return undefined;
	const validEntityIds = entityIds.filter(
		(entityId): entityId is UUID =>
			typeof entityId === "string" && UUID_PATTERN.test(entityId),
	);
	if (validEntityIds.length !== entityIds.length) return undefined;
	return {
		roomId: roomId as UUID,
		entityIds: validEntityIds,
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

function normalizeScope(value: unknown): MemoryScope {
	switch (value) {
		case "shared":
		case "private":
		case "room":
		case "global":
		case "owner-private":
		case "user-private":
		case "agent-private":
			return value;
		default:
			return "owner-private";
	}
}

function stringUuid(value: unknown): UUID | undefined {
	return typeof value === "string" && UUID_PATTERN.test(value)
		? (value as UUID)
		: undefined;
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
		stringUuid(metadata?.scopedToEntityId) ??
		stringUuid(metadata?.addedBy) ??
		memory.entityId;
	return {
		scope: normalizeScope(metadata?.scope),
		...(scopedEntityId ? { scopedEntityId } : {}),
		grants: parseArtifactShareGrants(metadata),
	};
}

/**
 * Decide what `ctx`'s requester may see of one artifact record.
 *
 * Tier order (most privileged first):
 *  1. No access context → `full`. The single-owner local boundary deliberately
 *     omits a context (see `RouteHandlerContext.accessContext`), and existing
 *     unfiltered behavior there is a documented product decision.
 *  2. Agent self-read, OWNER, or ADMIN rank → `full`.
 *  3. An explicit per-entity grant wins in BOTH directions: a `full` grant
 *     elevates past the scope ladder, and a `redacted` grant narrows the viewer
 *     to the variant even when the scope ladder would allow full — the owner's
 *     per-viewer instruction (e.g. an admin "redact for everyone" pass) must
 *     not be undone by a coarse `global` scope.
 *  4. No grant → the scope ladder (`canReadScope`): a USER still reads global
 *     records and their own user-private records in full; the `owner-private`
 *     default fails closed to `none`.
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

/** Resolve artifact disclosure directly from a memory row. */
export function resolveArtifactDisclosureForMemory(
	memory: Pick<Memory, "entityId" | "metadata">,
	ctx: AccessContext | undefined,
	agentId: UUID,
): ArtifactDisclosure {
	return resolveArtifactDisclosure(
		artifactDisclosureRecordFromMemory(memory),
		ctx,
		agentId,
	);
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

/** Boolean artifact predicate for disclosure points that only need allow/deny. */
export function canAccessArtifact(
	record: ArtifactDisclosureRecord,
	ctx: AccessContext | undefined,
	agentId: UUID,
): boolean {
	return resolveArtifactDisclosure(record, ctx, agentId) !== "none";
}

/**
 * Select the concrete full/redacted reference for a DTO after the caller has
 * resolved disclosure. A redacted grant never falls back to full bytes; if no
 * redacted variant exists the artifact is omitted until the variant writer
 * catches up.
 */
export function selectArtifactVariant<TFull, TRedacted = TFull>(
	disclosure: ArtifactDisclosure,
	references: ArtifactVariantReferences<TFull, TRedacted>,
): ResolvedArtifactVariant<TFull | TRedacted> | null {
	if (disclosure === "none") return null;
	if (disclosure === "full") {
		return { disclosure: "full", value: references.full };
	}
	if (references.redacted == null) return null;
	return { disclosure: "redacted", value: references.redacted };
}
