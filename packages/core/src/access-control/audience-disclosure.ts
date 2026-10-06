/**
 * Computes audience disclosure as the minimum admitted level across non-agent members.
 * Callers must first verify audience freshness and binding. Missing, malformed, or empty
 * evidence and resolver failures grant nothing. Per-viewer policy preserves artifact-
 * disclosure precedence: owner/admin authority, then explicit grants, then scope.
 */

import type { TrustedDeliveryAudience } from "../security/trusted-delivery-audience";
import type { AccessContext } from "../types/access-context.js";
import type { DisclosureSubject } from "../types/memory.js";
import type { UUID } from "../types/primitives.js";
import type {
	ArtifactDisclosure,
	ArtifactDisclosureRecord,
} from "./artifact-disclosure";
import { resolveArtifactDisclosure } from "./artifact-disclosure";
import { isMemoryScope } from "./memory-scope.js";

// The subject shape lives in the types layer so the `DisclosureGate` contract
// (also in the types layer) can reference it without a barrel cycle. Re-export
// it here so this module's original public surface is unchanged.
export type { DisclosureSubject } from "../types/memory.js";

/**
 * The universal disclosure level. Deliberately the SAME type as the artifact
 * read-side answer — one vocabulary, no parallel enum to drift.
 */
export type DisclosureLevel = ArtifactDisclosure;

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

/** The lower of two disclosure levels (none < redacted < full). */
export function minDisclosureLevel(
	a: DisclosureLevel,
	b: DisclosureLevel,
): DisclosureLevel {
	return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

/**
 * Maps a subject to the artifact-disclosure record so per-viewer evaluation uses the shared
 * role/grant/scope precedence.
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

/**
 * Build the per-viewer resolver a gate must use over an ATTESTED audience,
 * derived ONLY from the attestation — never from caller-supplied role fields.
 * Each member's `AccessContext` is minted from the census: the attested
 * `agentEntityId` is the agent self-read, the attested `canonicalOwnerEntityId`
 * is the sole OWNER, and every other participant is a bare USER (no role, no
 * `isOwner`) so the artifact scope ladder fails closed. The resolver then runs
 * `resolveArtifactDisclosure` over `disclosureSubjectRecord(subject)`, so gate
 * admission inherits the exact artifact tier order (agent/OWNER full → grant
 * beats ladder both directions → owner-private fails closed) with zero I/O.
 */
export function attestedAudienceViewerResolver(
	subject: DisclosureSubject,
	audience: TrustedDeliveryAudience,
): (entityId: UUID) => DisclosureLevel {
	const record = disclosureSubjectRecord(subject);
	const agentId = audience.agentEntityId;
	const ownerId = audience.canonicalOwnerEntityId;
	return (entityId) => {
		const ctx: AccessContext =
			ownerId !== null && entityId === ownerId
				? { requesterEntityId: entityId, role: "OWNER", isOwner: true }
				: { requesterEntityId: entityId };
		return resolveArtifactDisclosure(record, ctx, agentId);
	};
}

/**
 * Gate-side evaluation of the `audience_admission` disclosure policy: the
 * component is admitted only when the ATTESTED audience as a whole earns FULL
 * disclosure for `subject`. Returns `undefined` when admitted, or a
 * human-readable failure reason (mirroring `disclosureGateFailure`'s contract)
 * when the room caps below full — the reason names the capped level and the
 * count of blocking members so the denial is diagnosable without leaking who.
 *
 * Fail-closed by construction: a missing/unattested audience is passed straight
 * to `resolveAudienceAdmission`, which returns `none` for unusable evidence;
 * one ungranted non-agent member caps the room. This never widens access
 * relative to the owner-exclusive gate — an owner-private grant-free subject
 * admits full only in the degenerate two-party owner DM.
 */
export function audienceAdmissionGateFailure(
	subject: DisclosureSubject,
	audience: TrustedDeliveryAudience | undefined,
): string | undefined {
	if (!audience) {
		return "Audience-admission disclosure denied: missing_attestation";
	}
	const admission = resolveAudienceAdmission(
		subject,
		audience,
		attestedAudienceViewerResolver(subject, audience),
	);
	if (admission.level === "full") return undefined;
	// Surface a broken viewer lookup distinctly from a deliberate deny (PR1
	// follow-up recorded it on the admission for exactly this caller): a resolver
	// failure means the gate could not evaluate the room, not that policy denied
	// it — either way access is capped, but the reason must not read as a settled
	// policy decision.
	if (admission.resolverFailureEntityIds.length > 0) {
		return `Audience-admission disclosure denied: viewer resolution failed for ${admission.resolverFailureEntityIds.length} member(s) (capped at ${admission.level})`;
	}
	return `Audience-admission disclosure denied: capped at ${admission.level} by ${admission.blockingEntityIds.length} member(s)`;
}
