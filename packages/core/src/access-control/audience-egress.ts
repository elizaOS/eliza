/**
 * Derives per-viewer disclosure from an authenticated audience without I/O. The canonical
 * owner receives OWNER authority; other members receive USER authority plus explicit grants.
 * Membership alone does not establish elevated roles. Callers revalidate evidence before
 * egress.
 */

import type { TrustedDeliveryAudience } from "../security/trusted-delivery-audience";
import type { DisclosureSubject } from "../types/memory.js";
import { validateUuid } from "../utils/uuid.js";
import {
	type AudienceAdmission,
	attestedAudienceViewerResolver,
	resolveAudienceAdmission,
} from "./audience-disclosure";
import { isMemoryScope, parseShareGrantList } from "./memory-scope.js";

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
	const scopedEntityId = validateUuid(record.scopedEntityId);
	const grants = parseShareGrantList(record.grants);
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
