/**
 * Typed contract for the durable capability-grant subsystem (#23102): the
 * versioned capability vocabulary, the grant record shape mirrored by
 * `capabilities.capability_grants`, the canonical `authorizeCapability`
 * request and decision (with audit id), and the fail-closed validation
 * helpers that canonicalize subjects, selectors, and capabilities before
 * they reach the store. Unknown or malformed input is rejected explicitly —
 * never coerced into a healthy-looking default grant.
 */

import type { UUID } from "../../types/index.ts";

/** Schema version of the capability vocabulary itself. */
export const CAPABILITY_VOCABULARY_VERSION = 1;

/** Canonical subject kinds understood by the grant store. */
export const CAPABILITY_SUBJECT_KINDS = ["entity", "role", "world"] as const;

export type CapabilitySubjectKind = (typeof CAPABILITY_SUBJECT_KINDS)[number];

/** Grant effects; an explicit deny outranks any number of allows. */
export const CAPABILITY_GRANT_EFFECTS = ["allow", "deny"] as const;

export type CapabilityGrantEffect = (typeof CAPABILITY_GRANT_EFFECTS)[number];

/** Where a grant may be issued from. */
export const CAPABILITY_PROVENANCES = [
	"api",
	"natural-language",
	"settings",
] as const;

export type CapabilityProvenance = (typeof CAPABILITY_PROVENANCES)[number];

/** Machine-readable decision outcome. */
export type CapabilityDecision = "allow" | "deny";

/** Machine-readable reason codes carried on decisions and audit rows. */
export const CAPABILITY_REASON_CODES = {
	/** A live deny grant matched; it outranks every allow. */
	DENY_GRANT_MATCHED: "DENY_GRANT_MATCHED",
	/** A live allow grant matched. */
	ALLOW_GRANT_MATCHED: "ALLOW_GRANT_MATCHED",
	/** No live grant matched the subject × capability × resource. */
	NO_MATCHING_GRANT: "NO_MATCHING_GRANT",
	/** The request was malformed; evaluation could not proceed. */
	INVALID_REQUEST: "INVALID_REQUEST",
	/** Grant-store access failed; fail closed. */
	STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
	/** Matching allow grants had incompatible constraints. */
	INCOMPATIBLE_CONSTRAINTS: "INCOMPATIBLE_CONSTRAINTS",
	/** A synthesized role-tier allow matched (composition hook). */
	ROLE_TIER_MATCHED: "ROLE_TIER_MATCHED",
	/** A role-tier resolver denied the request (composition hook). */
	ROLE_TIER_DENIED: "ROLE_TIER_DENIED",
} as const;

export type CapabilityReasonCode =
	(typeof CAPABILITY_REASON_CODES)[keyof typeof CAPABILITY_REASON_CODES];

/**
 * A durable capability grant as returned by the store. Field names mirror the
 * `capabilities.capability_grants` columns so rows translate without renames.
 */
export interface CapabilityGrant {
	id: UUID;
	subject: string;
	agentId: UUID;
	worldId: UUID | null;
	capability: string;
	resourceSelector: string;
	effect: CapabilityGrantEffect;
	issuer: string;
	issuedAt: Date;
	expiresAt: Date | null;
	revokedAt: Date | null;
	revocationReason: string | null;
	constraints: Record<string, unknown> | null;
	provenance: CapabilityProvenance;
	version: number;
}

/** Input for creating a grant; id/version are store-assigned. */
export interface CreateCapabilityGrantInput {
	subject: string;
	agentId: UUID;
	worldId?: UUID | null;
	capability: string;
	resourceSelector: string;
	effect: CapabilityGrantEffect;
	issuer: string;
	expiresAt?: Date | null;
	constraints?: Record<string, unknown> | null;
	provenance: CapabilityProvenance;
}

/** Input for version-checked grant mutation. */
export interface UpdateCapabilityGrantInput {
	id: UUID;
	/** Must equal the row's current version or the update is rejected. */
	expectedVersion: number;
	patch: {
		expiresAt?: Date | null;
		constraints?: Record<string, unknown> | null;
	};
}

/**
 * Resolves a canonical subject to the roles that apply for one evaluation.
 * Slice 1 ships the hook so composition order is fixed and testable; role
 * data itself is provided by the caller (trust feature / roles module in
 * slice 2+).
 */
/** Roles held by the subject for this evaluation, if any. */
export type CapabilityRoleResolver = (
	subject: string,
	context: { agentId: UUID; worldId?: UUID | null },
) => Promise<string[] | null>;

/**
 * Canonical authorization request evaluated by `authorizeCapability`.
 * `roleResolver` is the composition hook (RP Q3 gap 1): when provided, role
 * tiers evaluate AFTER explicit grants, so a deny grant still wins over any
 * role floor, and the decision names the layer that matched.
 */
export interface CapabilityAuthorizationRequest {
	subject: string;
	agentId: UUID;
	worldId?: UUID | null;
	capability: string;
	resource: string;
	/** Trusted clock override for tests; defaults to Date.now(). */
	now?: number;
	/** Optional role-tier composition hook (evaluated after grants). */
	roleResolver?: CapabilityRoleResolver;
	/**
	 * Optional sink for audit-write and role-resolver failures. Production
	 * boundaries wire this to `runtime.reportError`; without it the failures
	 * are silent to the caller (the decision itself is already fail-closed).
	 */
	onAuditFailure?: (error: unknown) => void;
}

/** Canonical authorization decision returned by `authorizeCapability`. */
export interface CapabilityAuthorizationResult {
	decision: CapabilityDecision;
	reasonCode: CapabilityReasonCode;
	/** Human-readable explanation. */
	reason: string;
	/** Grant the decision matched; null when nothing matched. */
	matchedGrantId: UUID | null;
	/** Matched grant's effect, echoed for callers. */
	effect: CapabilityGrantEffect | null;
	/** Intersected constraints of every matching allow grant. */
	constraints: Record<string, unknown>;
	/** Nearest expiry across matching allows; null when none expire. */
	expiresAt: Date | null;
	/**
	 * True when no grant matched and the capability is governed by an
	 * approval flow; the request must then be re-run through that flow
	 * instead of being treated as a plain denial.
	 */
	approvalRequired: boolean;
	/** Audit-row id for this decision (every decision writes one). */
	auditId: UUID;
	/**
	 * Evaluation layer that produced the decision, so one record names the
	 * winning layer: 'deny-grant' | 'allow-grant' | 'role-tier' | 'invalid' |
	 * 'no-match' | 'store-unavailable'.
	 */
	layer: string;
}

/** One enforcement-boundary row in the checked-in inventory. */
export interface CapabilityBoundaryInventoryEntry {
	/** Stable boundary id, e.g. `connector.message.send`. */
	id: string;
	/** Free-text description of what crossing this boundary does. */
	description: string;
	/** Enforcement status of this boundary in the current slice. */
	status: "enforced" | "inventory-only" | "planned";
	/** Where enforcement lives once wired; null until then. */
	owner: string | null;
}

const UUID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Validates and canonicalizes a subject string. Accepts `entity:<uuid>`,
 * `role:<name>`, and `world:<uuid>`; rejects empty, unknown-kind, and
 * malformed-uuid subjects. Returns an explicit invalid result instead of a
 * default subject.
 */
export function canonicalizeCapabilitySubject(
	value: unknown,
): { ok: true; subject: string } | { ok: false; error: string } {
	if (typeof value !== "string" || value.length === 0) {
		return { ok: false, error: "subject must be a non-empty string" };
	}
	const separator = value.indexOf(":");
	if (separator <= 0 || separator === value.length - 1) {
		return {
			ok: false,
			error: `subject must be "<kind>:<id>", got ${JSON.stringify(value)}`,
		};
	}
	const kind = value.slice(0, separator);
	const id = value.slice(separator + 1);
	if (!(CAPABILITY_SUBJECT_KINDS as readonly string[]).includes(kind)) {
		return {
			ok: false,
			error: `unknown subject kind ${JSON.stringify(kind)} (expected one of ${CAPABILITY_SUBJECT_KINDS.join(", ")})`,
		};
	}
	if (id.length === 0) {
		return { ok: false, error: "subject id must be non-empty" };
	}
	if (kind === "entity" || kind === "world") {
		if (!UUID_PATTERN.test(id)) {
			return {
				ok: false,
				error: `subject id for kind "${kind}" must be a UUID, got ${JSON.stringify(id)}`,
			};
		}
		return { ok: true, subject: `${kind}:${id.toLowerCase()}` };
	}
	if (!/^[a-z0-9-]+$/.test(id)) {
		return {
			ok: false,
			error: `role subject id must be lowercase alphanumeric/dash, got ${JSON.stringify(id)}`,
		};
	}
	return { ok: true, subject: value };
}

/**
 * Validates a capability name: dot-separated lowercase segments, at least
 * two segments, no wildcard anywhere.
 */
export function validateCapabilityName(
	value: unknown,
): { ok: true; capability: string } | { ok: false; error: string } {
	if (typeof value !== "string" || value.length < 3) {
		return {
			ok: false,
			error: "capability must be a string of at least 3 characters",
		};
	}
	if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(value)) {
		return {
			ok: false,
			error: `capability must be dot-separated lowercase segments (e.g. "connector.message.send"), got ${JSON.stringify(value)}`,
		};
	}
	return { ok: true, capability: value };
}

/**
 * Allowlist for selector characters: printable ASCII letters, digits, `-`,
 * `_`, `:`, `.`, `/`, the bare `*` (everything), or an optional trailing
 * `/*` wildcard. Rejects whitespace, control characters, quotes,
 * backslashes, and non-ASCII input.
 */
const SELECTOR_CHARSET = /^(?:\*|[A-Za-z0-9\-_:./]+(?:\/\*)?)$/;

/**
 * Validates and canonicalizes a resource selector: `*`, an exact resource id
 * (non-empty, no `*`, no leading/trailing/double slashes), or `<prefix>/*`
 * matching the prefix's descendants. Validation runs at grant-creation time
 * so malformed selectors are rejected by the write, not discovered at
 * evaluation; rows that pre-date stricter validation are quarantined (never
 * match, always audit) rather than trusted.
 */
export function canonicalizeResourceSelector(
	value: unknown,
): { ok: true; selector: string } | { ok: false; error: string } {
	if (typeof value !== "string" || value.length === 0) {
		return {
			ok: false,
			error: "resource selector must be a non-empty string",
		};
	}
	if (value.length > 512) {
		return {
			ok: false,
			error: `resource selector exceeds 512 characters, got ${value.length}`,
		};
	}
	// Strict charset (RP must-fix 3): printable ASCII only; star is legal
	// solely as the trailing `/*` wildcard (checked below).
	if (!SELECTOR_CHARSET.test(value)) {
		return {
			ok: false,
			error: `selector characters must be printable ASCII letters, digits, or - _ : . / (no spaces, quotes, backslashes, or non-ASCII); got ${JSON.stringify(value)}`,
		};
	}
	if (value === "*") {
		return { ok: true, selector: "*" };
	}
	if (value.endsWith("/*")) {
		const prefix = value.slice(0, -2);
		if (
			prefix.length === 0 ||
			prefix.startsWith("/") ||
			prefix.endsWith("/") ||
			prefix.includes("*") ||
			prefix.includes("//")
		) {
			return {
				ok: false,
				error: `wildcard selector prefix must be non-empty and slash-trimmed, got ${JSON.stringify(value)}`,
			};
		}
		return { ok: true, selector: value };
	}
	if (value.includes("*")) {
		return {
			ok: false,
			error: `selector wildcards are only allowed as a trailing "/*", got ${JSON.stringify(value)}`,
		};
	}
	if (value.includes("//") || value.startsWith("/") || value.endsWith("/")) {
		return {
			ok: false,
			error: `exact selectors must be slash-trimmed with non-empty segments, got ${JSON.stringify(value)}`,
		};
	}
	return { ok: true, selector: value };
}

/**
 * True when `selector` (already canonicalized) authorizes `resource`.
 * `*` matches everything; `<prefix>/*` matches the prefix's descendants
 * (the slash boundary is included in the prefix); otherwise the selector
 * must equal the resource exactly.
 */
export function selectorMatchesResource(
	selector: string,
	resource: string,
): boolean {
	if (selector === "*") {
		return true;
	}
	if (selector.endsWith("/*")) {
		const prefix = selector.slice(0, -1); // keep the trailing slash
		return resource.startsWith(prefix);
	}
	return selector === resource;
}

/** Validates a UUID-typed field without coercing. */
export function isValidUuid(value: unknown): value is UUID {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Parses a stored effect column value, failing closed on anything else. */
export function parseCapabilityGrantEffect(
	value: unknown,
): CapabilityGrantEffect | null {
	return (CAPABILITY_GRANT_EFFECTS as readonly string[]).includes(
		value as string,
	)
		? (value as CapabilityGrantEffect)
		: null;
}

/** Parses a stored provenance column value, failing closed on anything else. */
export function parseCapabilityProvenance(
	value: unknown,
): CapabilityProvenance | null {
	return (CAPABILITY_PROVENANCES as readonly string[]).includes(value as string)
		? (value as CapabilityProvenance)
		: null;
}

/** Scalar constraint values comparable by Set identity. */
function isScalarConstraintValue(
	value: unknown,
): value is string | number | boolean | null {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	);
}

/** Structural equality over JSON-shaped constraint values. */
export function jsonValuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return (
			a.length === b.length && a.every((item, i) => jsonValuesEqual(item, b[i]))
		);
	}
	if (typeof a === "object" && typeof b === "object") {
		if (Array.isArray(a) || Array.isArray(b)) return false;
		const ak = Object.keys(a as Record<string, unknown>);
		const bk = Object.keys(b as Record<string, unknown>);
		if (ak.length !== bk.length) return false;
		return ak.every((key) =>
			key in (b as Record<string, unknown>)
				? jsonValuesEqual(
						(a as Record<string, unknown>)[key],
						(b as Record<string, unknown>)[key],
					)
				: false,
		);
	}
	return false;
}

/**
 * Intersects the constraints of multiple matching allow grants:
 * most-restrictive wins per key (min for numbers, set intersection for
 * arrays, exact equality for everything else). Returns null when two grants
 * demand incompatible values for the same key — the decision must then deny
 * (INCOMPATIBLE_CONSTRAINTS), never silently pick one.
 */
export function intersectGrantConstraints(
	grants: Array<{ constraints: Record<string, unknown> | null }>,
): { ok: true; constraints: Record<string, unknown> } | { ok: false } {
	const merged: Record<string, unknown> = {};
	for (const grant of grants) {
		const constraints = grant.constraints;
		if (!constraints) continue;
		for (const [key, value] of Object.entries(constraints)) {
			const existing = merged[key];
			if (existing === undefined) {
				merged[key] = value;
				continue;
			}
			if (
				typeof existing === "number" &&
				typeof value === "number" &&
				Number.isFinite(existing) &&
				Number.isFinite(value)
			) {
				merged[key] = Math.min(existing, value);
				continue;
			}
			if (Array.isArray(existing) && Array.isArray(value)) {
				// Type-preserving intersection of scalars only: any
				// non-scalar member in EITHER array makes the combination
				// incompatible (deny) — never silently dropped.
				if (
					existing.some((item) => !isScalarConstraintValue(item)) ||
					value.some((item) => !isScalarConstraintValue(item))
				) {
					return { ok: false };
				}
				const seen = new Set(existing);
				const kept: unknown[] = [];
				for (const item of value) {
					if (seen.has(item) && !kept.includes(item)) {
						kept.push(item);
					}
				}
				merged[key] = kept;
				continue;
			}
			if (!jsonValuesEqual(existing, value)) {
				return { ok: false };
			}
		}
	}
	return { ok: true, constraints: merged };
}

/** Truncates an audit resource id to the column cap, suffixing on cut. */
export function truncateAuditResource(resource: string): string {
	const MAX_AUDIT_RESOURCE = 512;
	if (resource.length <= MAX_AUDIT_RESOURCE) {
		return resource;
	}
	return `${resource.slice(0, MAX_AUDIT_RESOURCE - 3)}...`;
}
