/**
 * Derives per-viewer disclosure from an authenticated audience without I/O. The canonical
 * owner receives OWNER authority; other members receive USER authority plus explicit grants.
 * Membership alone does not establish elevated roles. Callers revalidate evidence before
 * egress.
 */

import type { TrustedDeliveryAudience } from "../security/trusted-delivery-audience";
import type {
	ArtifactShareGrant,
	ArtifactShareGrantMode,
} from "../types/memory.js";
import type { UUID } from "../types/primitives.js";
import {
	type AudienceAdmission,
	attestedAudienceViewerResolver,
	type DisclosureSubject,
	resolveAudienceAdmission,
} from "./audience-disclosure";
import { isMemoryScope } from "./memory-scope.js";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
		// The attestation-derived resolver lives in the policy module. Keeping a
		// second copy here would mean two implementations of the same
		// fail-closed security floor, free to drift apart.
		attestedAudienceViewerResolver(subject, audience),
	);
}
