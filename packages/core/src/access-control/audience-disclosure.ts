/**
 * Min-over-members audience admission: the pure policy core that joins the
 * attested delivery-audience census (`TrustedDeliveryAudience`, the full
 * participant list minted at ingress and revalidated at egress) with the
 * per-viewer disclosure vocabulary (`ArtifactDisclosure`: full / redacted /
 * none, per-entity grants) that until now only served read-side artifact DTOs.
 *
 * One question, answered deterministically: given a disclosure subject (what
 * the data requires) and an attested audience (who is verifiably in the room),
 * what disclosure level does the audience AS A WHOLE admit? The answer is the
 * MINIMUM over the non-agent members — one ungranted participant caps the whole
 * room, exactly like one stranger at the table caps what gets said out loud.
 *
 * This module is PURE and performs no I/O. It does not consult rooms, entities,
 * or clocks. Attestation validity (expiry, actor/room binding, membership
 * drift) is the caller's contract: evaluate/revalidate the audience through
 * `trusted-delivery-audience` FIRST, then compute admission over the surviving
 * evidence. Nothing here is wired into any gate or egress path yet; the
 * owner-exclusive gate remains the sole enforced disclosure decision until the
 * `audience_admission` gate variant lands.
 *
 * Fail-closed rules, in order:
 *  - malformed subject (unrecognized scope) → every member "none";
 *  - missing/malformed audience evidence → level "none", no members admitted;
 *  - empty census (no non-agent members) → level "none";
 *  - a viewer resolver that throws or returns a non-level value → that member
 *    is "none" (a broken lookup grants nothing, mirroring the malformed-grant
 *    rule in `artifact-disclosure`).
 *
 * Per-member evaluation MUST follow the same tier order as
 * `resolveArtifactDisclosure` (agent-self/OWNER/ADMIN full; explicit grant
 * beats the scope ladder in BOTH directions; owner-private default fails
 * closed). Callers get that for free by wrapping `resolveArtifactDisclosure`
 * over `disclosureSubjectRecord(subject)` — this module deliberately does not
 * re-apply grants on top of the resolver, because tier 2 (OWNER/ADMIN full)
 * outranks grants and re-narrowing here would diverge from the artifact
 * matrix.
 *
 * `owner_exclusive` stays the degenerate case: an owner-private subject with no
 * grants admits "full" only when every non-agent member resolves full — in a
 * two-party owner DM that is the owner alone, which is byte-equivalent to what
 * `decisionFromAudience` allows (see the parity tests).
 */
import type { TrustedDeliveryAudience } from "../security/trusted-delivery-audience";
import type { ArtifactShareGrant, MemoryScope, UUID } from "../types";
import type {
	ArtifactDisclosure,
	ArtifactDisclosureRecord,
} from "./artifact-disclosure";

/**
 * The universal disclosure level. Deliberately the SAME type as the artifact
 * read-side answer — one vocabulary, no parallel enum to drift.
 */
export type DisclosureLevel = ArtifactDisclosure;

/** What a sensitive span/surface requires of each viewer. */
export interface DisclosureSubject {
	/** Stored visibility scope; `owner-private` is the fail-closed default. */
	scope: MemoryScope;
	/** Entity the subject is scoped to (owner/speaker), for entity-scoped tiers. */
	scopedEntityId?: UUID;
	/** Explicit per-entity grants; a grant beats the ladder in both directions. */
	grants?: readonly ArtifactShareGrant[];
}

/** The admission decision for one subject over one attested audience. */
export interface AudienceAdmission {
	/** Min over all non-agent members: none < redacted < full. */
	level: DisclosureLevel;
	/** Each evaluated member's individual level. */
	perEntity: ReadonlyMap<UUID, DisclosureLevel>;
	/**
	 * Members whose level is below the subject's required level (`full` — the
	 * subject as stored; a redacted-capped member still blocks full delivery).
	 */
	blockingEntityIds: readonly UUID[];
	/**
	 * Members whose resolver threw. They are admitted nothing, exactly like an
	 * explicit deny — but a caller reporting "who blocked this" must be able to
	 * tell a deliberate denial from a resolver that failed, or a broken viewer
	 * lookup looks like a policy decision forever.
	 */
	resolverFailureEntityIds: readonly UUID[];
}

const LEVEL_RANK: Readonly<Record<DisclosureLevel, number>> = Object.freeze({
	none: 0,
	redacted: 1,
	full: 2,
});

const EMPTY_UUIDS: readonly UUID[] = Object.freeze([]);

function isDisclosureLevel(value: unknown): value is DisclosureLevel {
	return value === "full" || value === "redacted" || value === "none";
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

/** The lower of two disclosure levels (none < redacted < full). */
export function minDisclosureLevel(
	a: DisclosureLevel,
	b: DisclosureLevel,
): DisclosureLevel {
	return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

/**
 * Map a subject onto the artifact-disclosure record shape so callers can build
 * the per-viewer resolver directly over `resolveArtifactDisclosure` and inherit
 * the exact tier order (agent/OWNER/ADMIN full → grant → scope ladder →
 * fail closed). Keeping the mapping here means PR2+ gate callers cannot
 * hand-roll a divergent record shape.
 */
export function disclosureSubjectRecord(
	subject: DisclosureSubject,
): ArtifactDisclosureRecord {
	return {
		scope: subject.scope,
		...(subject.scopedEntityId
			? { scopedEntityId: subject.scopedEntityId }
			: {}),
		...(subject.grants ? { grants: subject.grants } : {}),
	};
}

/**
 * Non-agent members of an attested audience, deduplicated. Returns `null` when
 * the evidence object is structurally unusable (fail closed — a caller that
 * lost or never had attestation must not compute a permissive admission).
 */
function audienceMembers(
	audience: TrustedDeliveryAudience,
): readonly UUID[] | null {
	if (!audience || typeof audience !== "object") return null;
	const { participantEntityIds, agentEntityId } = audience;
	if (!Array.isArray(participantEntityIds)) return null;
	if (typeof agentEntityId !== "string" || agentEntityId.length === 0) {
		return null;
	}
	const members = new Set<UUID>();
	for (const id of participantEntityIds) {
		if (typeof id !== "string" || id.length === 0) return null;
		if (id === agentEntityId) continue;
		members.add(id);
	}
	return [...members];
}

/**
 * Compute the admission an attested audience earns for one disclosure subject.
 *
 * Iterates `audience.participantEntityIds` EXCLUDING the agent, evaluates each
 * member through `resolveViewer` (which must implement the
 * `resolveArtifactDisclosure` tier order — see `disclosureSubjectRecord`), and
 * returns the minimum level over all members plus the members blocking the
 * subject's required level (`"full"`, i.e. the subject as stored — a member
 * capped at redacted or none blocks unredacted delivery).
 *
 * Fail-closed: empty or unattested audiences admit `"none"`; a resolver that
 * throws or answers with anything but a disclosure level marks that member
 * `"none"`. A malformed subject scope collapses every member to `"none"` — a
 * corrupt gate definition cannot widen access.
 *
 * Pure and clock-free: attestation freshness/membership drift must already be
 * verified by the caller via `revalidateOwnerExclusiveDisclosure`-style checks.
 */
export function resolveAudienceAdmission(
	subject: DisclosureSubject,
	audience: TrustedDeliveryAudience,
	resolveViewer: (entityId: UUID) => DisclosureLevel,
): AudienceAdmission {
	const required: DisclosureLevel = "full";
	const subjectUsable =
		!!subject && typeof subject === "object" && isMemoryScope(subject.scope);
	const members = audienceMembers(audience);
	const perEntity = new Map<UUID, DisclosureLevel>();
	if (members === null || members.length === 0) {
		// Fail closed: no verifiable census means no audience earns anything,
		// and an empty room has nobody to disclose to. (Not an error-policy
		// case — this is an ordinary guard, and tagging it would pollute the
		// grep that exists to audit retained catches.)
		return Object.freeze({
			level: "none" as const,
			perEntity,
			blockingEntityIds: EMPTY_UUIDS,
			resolverFailureEntityIds: EMPTY_UUIDS,
		});
	}
	const blocking: UUID[] = [];
	const resolverFailures: UUID[] = [];
	let level: DisclosureLevel = "full";
	for (const entityId of members) {
		let memberLevel: DisclosureLevel = "none";
		if (subjectUsable) {
			try {
				const resolved = resolveViewer(entityId);
				memberLevel = isDisclosureLevel(resolved) ? resolved : "none";
			} catch {
				// error-policy:J4 a viewer that cannot be evaluated is admitted
				// nothing, so a lookup failure never degrades into access. This
				// module is deliberately pure, so it cannot report the fault
				// itself — instead the member is recorded in
				// `resolverFailureEntityIds`, which makes the failure a visibly
				// distinct state rather than one indistinguishable from a
				// deliberate deny. The gate caller is responsible for surfacing
				// it.
				memberLevel = "none";
				resolverFailures.push(entityId);
			}
		}
		perEntity.set(entityId, memberLevel);
		level = minDisclosureLevel(level, memberLevel);
		if (LEVEL_RANK[memberLevel] < LEVEL_RANK[required]) {
			blocking.push(entityId);
		}
	}
	return Object.freeze({
		level,
		perEntity,
		blockingEntityIds: Object.freeze(blocking),
		resolverFailureEntityIds: Object.freeze(resolverFailures),
	});
}
