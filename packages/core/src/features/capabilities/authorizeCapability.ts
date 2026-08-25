/**
 * Canonical capability-authorization entry point (#23102). `authorizeCapability`
 * is the single decision path for durable grants. Evaluation order is fixed:
 * validate (fail closed) → deny grants → allow grants (constraints
 * intersected; incompatible → deny) → role tier (composition hook, only if a
 * resolver is provided and no grant matched) → deny NO_MATCHING_GRANT. Every
 * decision writes exactly one audit row whose id is generated UP FRONT so it
 * can be returned synchronously even when the audit write itself fails (that
 * failure is reported, never swallowed into an allow). There is deliberately
 * no decision cache — revocation is effective before the next call returns —
 * and no implicit allow. Boundaries that enforce call this function; nothing
 * reads `capabilities.capability_grants` directly.
 */

import type { UUID } from "../../types/index.ts";
import type { CapabilityStoreDb } from "./CapabilityGrantStore.ts";
import {
	appendCapabilityAudit,
	listLiveGrantsFor,
} from "./CapabilityGrantStore.ts";
import type {
	CapabilityAuthorizationRequest,
	CapabilityAuthorizationResult,
	CapabilityGrant,
} from "./types.ts";
import {
	CAPABILITY_REASON_CODES,
	canonicalizeCapabilitySubject,
	intersectGrantConstraints,
	isValidUuid,
	selectorMatchesResource,
	validateCapabilityName,
} from "./types.ts";

/** Null-agent sentinel for auditing malformed requests safely. */
const NIL_AGENT = "00000000-0000-0000-0000-000000000000" as UUID;

/** Best-effort audit write; returns true when the row landed. */
async function writeAudit(
	db: CapabilityStoreDb,
	input: Parameters<typeof appendCapabilityAudit>[1],
): Promise<boolean> {
	try {
		await appendCapabilityAudit(db, input);
		return true;
	} catch (error) {
		// error-policy:J7 — audit-sink failure is reported (the caller's
		// boundary logs it via runtime.reportError), never blocks the
		// decision, and never converts a denial into an allow.
		loggerAuditFailure(error);
		return false;
	}
}

/** Isolated so tests can observe audit-failure reporting. */
export const auditFailureReports: unknown[] = [];
function loggerAuditFailure(error: unknown): void {
	auditFailureReports.push(error);
}

/**
 * Denial result helper shared by every fail-closed path. The audit row must
 * still land for malformed requests, but raw malformed field values (e.g. a
 * non-uuid agentId) would violate column constraints, so each audited field
 * is sanitized to its string form with a deterministic null-agent sentinel.
 */
async function denyWithAudit(
	db: CapabilityStoreDb,
	request: CapabilityAuthorizationRequest,
	reasonCode: string,
	reason: string,
	layer: string,
	options?: { approvalRequired?: boolean },
): Promise<CapabilityAuthorizationResult> {
	const auditId = crypto.randomUUID() as UUID;
	const auditedAgentId = isValidUuid(request.agentId)
		? request.agentId
		: NIL_AGENT;
	await writeAudit(db, {
		auditId,
		agentId: auditedAgentId,
		subject: typeof request.subject === "string" ? request.subject : "",
		capability:
			typeof request.capability === "string" ? request.capability : "",
		resource: typeof request.resource === "string" ? request.resource : "",
		decision: "deny",
		reasonCode,
		details: reason,
		approvalRequired: options?.approvalRequired ?? false,
	});
	return {
		decision: "deny",
		reasonCode: reasonCode as CapabilityAuthorizationResult["reasonCode"],
		reason,
		matchedGrantId: null,
		effect: null,
		constraints: {},
		expiresAt: null,
		approvalRequired: options?.approvalRequired ?? false,
		auditId,
		layer,
	};
}

/** Mints the decision's audit id up front (returned even if the write fails). */
function newAuditId(): UUID {
	return crypto.randomUUID() as UUID;
}

/** Allow result from the winning grant set (constraints intersected). */
function allowFromGrants(
	grants: CapabilityGrant[],
	auditId: UUID,
	constraints: Record<string, unknown>,
): CapabilityAuthorizationResult {
	// The nearest expiry across matching allows governs the decision.
	const expiring = grants
		.map((grant) => grant.expiresAt)
		.filter((value): value is Date => value !== null)
		.sort((a, b) => a.getTime() - b.getTime());
	const primary = grants[0];
	return {
		decision: "allow",
		reasonCode: CAPABILITY_REASON_CODES.ALLOW_GRANT_MATCHED,
		reason: `Allowed by grant ${primary.id} (${grants.length} matching live allow${grants.length === 1 ? "" : "s"}, constraints intersected)`,
		matchedGrantId: primary.id,
		effect: primary.effect,
		constraints,
		expiresAt: expiring[0] ?? null,
		approvalRequired: false,
		auditId,
		layer: "allow-grant",
	};
}

/**
 * Evaluate one authorization request against the durable grant store.
 * Semantics (per #23102 + RP investigation findings):
 * - malformed subject/capability/agentId/resource/worldId → deny INVALID_REQUEST
 * - store failure → deny STORE_UNAVAILABLE (fail closed, audit attempted)
 * - expired or revoked grants never match (filtered in SQL)
 * - rows with quarantined (non-canonicalizable) selectors never match
 * - an explicit deny matching the resource outranks any allow and any role
 * - matching allows intersect constraints; incompatible values → deny
 * - role tier (when a resolver is provided) evaluates only when no grant
 *   matched, so grants always override the role floor, and the decision
 *   names the layer that matched
 * - no matching grant or role → deny NO_MATCHING_GRANT (no implicit allow)
 * - every decision writes exactly one audit row (id returned up front)
 */
export async function authorizeCapability(
	db: CapabilityStoreDb,
	request: CapabilityAuthorizationRequest,
): Promise<CapabilityAuthorizationResult> {
	const subject = canonicalizeCapabilitySubject(request.subject);
	if (!subject.ok) {
		return denyWithAudit(
			db,
			request,
			CAPABILITY_REASON_CODES.INVALID_REQUEST,
			`Invalid subject: ${subject.error}`,
			"invalid",
		);
	}
	const capability = validateCapabilityName(request.capability);
	if (!capability.ok) {
		return denyWithAudit(
			db,
			request,
			CAPABILITY_REASON_CODES.INVALID_REQUEST,
			`Invalid capability: ${capability.error}`,
			"invalid",
		);
	}
	if (!isValidUuid(request.agentId)) {
		return denyWithAudit(
			db,
			request,
			CAPABILITY_REASON_CODES.INVALID_REQUEST,
			`Invalid agentId: ${JSON.stringify(request.agentId)}`,
			"invalid",
		);
	}
	if (typeof request.resource !== "string" || request.resource.length === 0) {
		return denyWithAudit(
			db,
			request,
			CAPABILITY_REASON_CODES.INVALID_REQUEST,
			"resource must be a non-empty string",
			"invalid",
		);
	}
	if (
		request.worldId !== undefined &&
		request.worldId !== null &&
		!isValidUuid(request.worldId)
	) {
		return denyWithAudit(
			db,
			request,
			CAPABILITY_REASON_CODES.INVALID_REQUEST,
			`Invalid worldId: ${JSON.stringify(request.worldId)}`,
			"invalid",
		);
	}

	let grants: CapabilityGrant[];
	try {
		grants = await listLiveGrantsFor(db, {
			subject: subject.subject,
			agentId: request.agentId,
			worldId: request.worldId ?? null,
			capability: capability.capability,
			now: request.now,
		});
	} catch (error) {
		return denyWithAudit(
			db,
			request,
			CAPABILITY_REASON_CODES.STORE_UNAVAILABLE,
			`Grant store unavailable: ${error instanceof Error ? error.message : String(error)}`,
			"store-unavailable",
		);
	}

	// Explicit deny wins: any live deny grant whose selector matches the
	// resource ends evaluation. Denies outrank allows AND the role tier.
	for (const grant of grants) {
		if (grant.effect !== "deny") continue;
		if (selectorMatchesResource(grant.resourceSelector, request.resource)) {
			const auditId = newAuditId();
			await writeAudit(db, {
				auditId,
				agentId: request.agentId,
				subject: subject.subject,
				capability: capability.capability,
				resource: request.resource,
				decision: "deny",
				reasonCode: CAPABILITY_REASON_CODES.DENY_GRANT_MATCHED,
				details: `Denied by grant ${grant.id} (explicit deny outranks allow and role tiers)`,
				matchedGrantId: grant.id,
				constraints: grant.constraints ?? null,
				grantExpiresAt: grant.expiresAt,
				approvalRequired: false,
				grantVersion: grant.version,
			});
			return {
				decision: "deny",
				reasonCode: CAPABILITY_REASON_CODES.DENY_GRANT_MATCHED,
				reason: `Denied by explicit deny grant ${grant.id}`,
				matchedGrantId: grant.id,
				effect: grant.effect,
				constraints: grant.constraints ?? {},
				expiresAt: grant.expiresAt,
				approvalRequired: false,
				auditId,
				layer: "deny-grant",
			};
		}
	}

	// Allow scan: collect every matching live allow, intersect constraints.
	const matching: CapabilityGrant[] = [];
	for (const grant of grants) {
		if (grant.effect !== "allow") continue;
		if (selectorMatchesResource(grant.resourceSelector, request.resource)) {
			matching.push(grant);
		}
	}
	if (matching.length > 0) {
		const intersection = intersectGrantConstraints(matching);
		if (!intersection.ok) {
			const auditId = newAuditId();
			await writeAudit(db, {
				auditId,
				agentId: request.agentId,
				subject: subject.subject,
				capability: capability.capability,
				resource: request.resource,
				decision: "deny",
				reasonCode: CAPABILITY_REASON_CODES.INCOMPATIBLE_CONSTRAINTS,
				details: `Matching allow grants ${matching.map((g) => g.id).join(", ")} carry incompatible constraints`,
				approvalRequired: false,
			});
			return {
				decision: "deny",
				reasonCode: CAPABILITY_REASON_CODES.INCOMPATIBLE_CONSTRAINTS,
				reason:
					"Matching allow grants carry incompatible constraints; denying rather than picking one",
				matchedGrantId: matching[0].id,
				effect: null,
				constraints: {},
				expiresAt: null,
				approvalRequired: false,
				auditId,
				layer: "allow-grant",
			};
		}
		const auditId = newAuditId();
		await writeAudit(db, {
			auditId,
			agentId: request.agentId,
			subject: subject.subject,
			capability: capability.capability,
			resource: request.resource,
			decision: "allow",
			reasonCode: CAPABILITY_REASON_CODES.ALLOW_GRANT_MATCHED,
			details: `Allowed by ${matching.length} matching live allow grant(s)`,
			matchedGrantId: matching[0].id,
			constraints: intersection.constraints,
			grantExpiresAt:
				matching
					.map((g) => g.expiresAt)
					.filter((v): v is Date => v !== null)
					.sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
			approvalRequired: false,
			grantVersion: matching[0].version,
		});
		return allowFromGrants(matching, auditId, intersection.constraints);
	}

	// Role tier (composition hook): evaluated only when no grant matched, so
	// an explicit deny grant beats any role floor and grants override roles.
	if (request.roleResolver) {
		let roles: string[] | null = null;
		try {
			roles = await request.roleResolver(subject.subject, {
				agentId: request.agentId,
				worldId: request.worldId ?? null,
			});
		} catch (error) {
			// error-policy:J4 — a broken role resolver degrades to the plain
			// no-match denial; it must never widen access.
			roles = null;
			loggerAuditFailure(error);
		}
		if (roles && roles.length > 0) {
			// Slice 1 models the NONE floor only: roles present means the
			// role-tier layer vouches for the subject's base actions. The
			// full role→capability mapping is slice 2+; here the tier says
			// "allow what the floor grants", which for this slice is nothing
			// beyond what grants already said (no match), so record the layer
			// and fall through to the no-match denial naming it.
			const auditId = newAuditId();
			await writeAudit(db, {
				auditId,
				agentId: request.agentId,
				subject: subject.subject,
				capability: capability.capability,
				resource: request.resource,
				decision: "deny",
				reasonCode: CAPABILITY_REASON_CODES.NO_MATCHING_GRANT,
				details: `Role tier evaluated (roles: ${roles.join(", ")}) but grants no floor capability in slice 1`,
				approvalRequired: false,
			});
			return {
				decision: "deny",
				reasonCode: CAPABILITY_REASON_CODES.NO_MATCHING_GRANT,
				reason:
					"No matching live grant; role tier evaluated but grants no additional capability in slice 1",
				matchedGrantId: null,
				effect: null,
				constraints: {},
				expiresAt: null,
				approvalRequired: false,
				auditId,
				layer: "role-tier",
			};
		}
	}

	// No live grant matched and no role tier vouched: deny (no implicit
	// allow). Approval flows for governed capabilities are a follow-up slice;
	// approvalRequired stays false and the decision is a plain denial.
	return denyWithAudit(
		db,
		request,
		CAPABILITY_REASON_CODES.NO_MATCHING_GRANT,
		"No matching live grant",
		"no-match",
	);
}
