/**
 * Egress-seam glue for min-over-members audience admission (#split-disclosure).
 *
 * The pure policy core (`resolveAudienceAdmission`, PR1) answers "given a
 * disclosure subject and an attested audience, what does the audience AS A
 * WHOLE admit?" — but it takes a caller-supplied per-viewer resolver. This
 * module is the ONE place the egress path builds that resolver, so the
 * delivery seam never hand-rolls the per-member AccessContext and can never
 * diverge from the artifact tier order.
 *
 * The resolver is derived PURELY from the attested audience evidence
 * (`TrustedDeliveryAudience`) — no room reads, no entity-role I/O in the hot
 * delivery path. Membership/role facts the attestation already carries:
 *
 *  - the AGENT (`agentEntityId`) never appears in the census the policy core
 *    iterates, so it needs no resolver branch;
 *  - the canonical OWNER (`canonicalOwnerEntityId`) resolves as role `OWNER`
 *    (`isOwner: true`) — tier 2 of `resolveArtifactDisclosure`, unconditional
 *    `full`;
 *  - every other participant resolves as the least-privileged `USER` tier with
 *    NO role and NO ownership, so the artifact scope ladder applies: a `full`
 *    grant elevates them, a `redacted` grant narrows them, and the
 *    `owner-private` default fails closed to `none`.
 *
 * This is deliberately the fail-closed floor: attestation proves who is in the
 * room, not what elevated world-role a non-owner participant might hold, so a
 * non-owner is admitted only what an explicit grant or an open scope allows.
 * A later PR that wants to honor ADMIN-rank participants must feed resolved
 * roles in explicitly; until then egress never widens past owner+grants, which
 * is the safe direction.
 *
 * Pure and clock-free. Attestation freshness / membership drift is the egress
 * caller's contract (revalidate via `revalidateOwnerExclusiveDisclosure`-style
 * checks BEFORE computing admission); this module only maps verified evidence
 * onto the policy core.
 */
import type { TrustedDeliveryAudience } from "../security/trusted-delivery-audience";
import type {
	AccessContext,
	ArtifactShareGrant,
	ArtifactShareGrantMode,
	MemoryScope,
	UUID,
} from "../types";
import { resolveArtifactDisclosure } from "./artifact-disclosure";
import {
	type AudienceAdmission,
	type DisclosureLevel,
	type DisclosureSubject,
	disclosureSubjectRecord,
	resolveAudienceAdmission,
} from "./audience-disclosure";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function stringUuid(value: unknown): UUID | undefined {
	return typeof value === "string" && UUID_PATTERN.test(value)
		? (value as UUID)
		: undefined;
}

/**
 * Parse untrusted grant entries off a stored/serialized value into typed
 * grants. Mirrors `parseArtifactShareMetadata` fail-closed rules: a grant that
 * cannot be read grants NOTHING (dropped), never a default.
 */
// error-policy:J3 untrusted-input sanitizing — a response's declared subject is
// model-adjacent data; invalid grant entries yield an empty result, never a
// fabricated grant.
function parseGrants(value: unknown): ArtifactShareGrant[] {
	if (!Array.isArray(value)) return [];
	const out: ArtifactShareGrant[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const g = entry as Record<string, unknown>;
		const entityId = stringUuid(g.entityId);
		if (!entityId) continue;
		if (g.mode !== "full" && g.mode !== "redacted") continue;
		out.push({
			entityId,
			mode: g.mode as ArtifactShareGrantMode,
			...(stringUuid(g.grantedBy)
				? { grantedBy: stringUuid(g.grantedBy) }
				: {}),
			...(typeof g.grantedAtMs === "number"
				? { grantedAtMs: g.grantedAtMs }
				: {}),
		});
	}
	return out;
}

/**
 * Parse a disclosure subject a response declares it requires of its audience
 * (the `content.data.disclosureSubject` egress marker). Returns `undefined`
 * when no subject is declared — the response is unscoped and egress applies no
 * audience-admission narrowing beyond the existing owner-exclusive seam.
 *
 * Fail-closed on a MALFORMED subject: a declared-but-unreadable subject (an
 * object with no recognizable scope) collapses to the `owner-private` default,
 * so a corrupt marker can only narrow delivery, never widen it. Only a fully
 * absent marker means "unscoped".
 */
export function parseEgressDisclosureSubject(
	value: unknown,
): DisclosureSubject | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object") {
		// A present-but-non-object marker is a corrupt declaration, not "unscoped":
		// fail closed to the most restrictive subject.
		return { scope: "owner-private" };
	}
	const record = value as Record<string, unknown>;
	const scope = isMemoryScope(record.scope) ? record.scope : "owner-private";
	const scopedEntityId = stringUuid(record.scopedEntityId);
	const grants = parseGrants(record.grants);
	return {
		scope,
		...(scopedEntityId ? { scopedEntityId } : {}),
		...(grants.length > 0 ? { grants } : {}),
	};
}

/**
 * The per-member AccessContext egress derives from attested evidence alone.
 *
 * The canonical owner gets the OWNER tier (`isOwner: true`), every other
 * participant gets the bare `USER` tier (no role, not owner) so the artifact
 * scope ladder / grant matrix decides — the fail-closed floor described in the
 * module header.
 */
function egressAccessContext(
	entityId: UUID,
	canonicalOwnerEntityId: UUID | null,
): AccessContext {
	if (canonicalOwnerEntityId !== null && entityId === canonicalOwnerEntityId) {
		return { requesterEntityId: entityId, isOwner: true, role: "OWNER" };
	}
	return { requesterEntityId: entityId };
}

/**
 * Build the per-viewer resolver the policy core requires, derived purely from
 * attested audience evidence. Every member is evaluated through the SAME
 * `resolveArtifactDisclosure` over `disclosureSubjectRecord(subject)` the
 * artifact read-side uses, so admission inherits the exact tier order
 * (agent/OWNER/ADMIN full → grant beats ladder both directions → owner-private
 * fails closed). The resolver is never hand-rolled at the call site.
 */
export function viewerResolverFromAudience(
	subject: DisclosureSubject,
	audience: TrustedDeliveryAudience,
): (entityId: UUID) => DisclosureLevel {
	const record = disclosureSubjectRecord(subject);
	const agentId = audience.agentEntityId;
	const canonicalOwnerEntityId = audience.canonicalOwnerEntityId;
	return (entityId) =>
		resolveArtifactDisclosure(
			record,
			egressAccessContext(entityId, canonicalOwnerEntityId),
			agentId,
		);
}

/**
 * Compute what the attested delivery audience admits for one disclosure
 * subject at the egress seam. A thin, fail-closed composition: build the
 * evidence-derived resolver, then defer to the pure policy core. The caller
 * (the delivery gate) decides what to do with a sub-`full` `level` — withhold,
 * redact, or replace — but the DECISION of what the room admits lives entirely
 * in the policy core, never in the seam.
 */
export function resolveEgressAudienceAdmission(
	subject: DisclosureSubject,
	audience: TrustedDeliveryAudience,
): AudienceAdmission {
	return resolveAudienceAdmission(
		subject,
		audience,
		viewerResolverFromAudience(subject, audience),
	);
}
