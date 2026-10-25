export type RoleName = "OWNER" | "ADMIN" | "USER" | "GUEST";
export const CANONICAL_ROLE_RANK = {
	NONE: 0,
	GUEST: 1,
	USER: 2,
	MEMBER: 2,
	ADMIN: 3,
	OWNER: 4,
} as const;

export const ROLE_RANK: Record<RoleName, number> = {
	GUEST: CANONICAL_ROLE_RANK.GUEST,
	USER: CANONICAL_ROLE_RANK.USER,
	ADMIN: CANONICAL_ROLE_RANK.ADMIN,
	OWNER: CANONICAL_ROLE_RANK.OWNER,
};

/**
 * Compares role ranks, including MEMBER/USER equivalence. Unknown or empty roles resolve to
 * NONE.
 */
export function hasAtLeastRole(
	role: string | undefined | null,
	minRole: keyof typeof CANONICAL_ROLE_RANK,
): boolean {
	const rank =
		CANONICAL_ROLE_RANK[
			(role ?? "").toUpperCase() as keyof typeof CANONICAL_ROLE_RANK
		] ?? 0;
	return rank >= CANONICAL_ROLE_RANK[minRole];
}

/** True iff `role` is ADMIN-rank or higher (ADMIN or OWNER).. */
export function isAdminRank(role: string | undefined | null): boolean {
	return hasAtLeastRole(role, "ADMIN");
}

export type RoleGateRole = keyof typeof CANONICAL_ROLE_RANK;

export interface RoleGate {
	/** Any one of these roles may pass. */
	roles?: RoleGateRole[];
	/** Alias for roles, useful for declarative gate objects. */
	anyOf?: RoleGateRole[];
	/** All listed roles must be present. */
	allOf?: RoleGateRole[];
	/** Any listed role denies access. */
	noneOf?: RoleGateRole[];
	/** Caller must have at least this role by rank. */
	minRole?: RoleGateRole;
}
//: single source of truth for role ranking — delegates to CANONICAL_ROLE_RANK.
const GATE_ROLE_RANK: Record<string, number> = CANONICAL_ROLE_RANK;

export function normalizeGateRole(role: RoleGateRole): RoleGateRole {
	const normalized = String(role).trim().toUpperCase();
	return (normalized === "USER" ? "MEMBER" : normalized) as RoleGateRole;
}

export function roleRank(role: RoleGateRole): number {
	return GATE_ROLE_RANK[String(normalizeGateRole(role))] ?? 0;
}

export function satisfiesRoleGate(
	userRoles: readonly RoleGateRole[] | undefined,
	gate: RoleGate | undefined,
): boolean {
	if (!gate) {
		return true;
	}

	const normalizedRoles = new Set((userRoles ?? []).map(normalizeGateRole));
	const highestRank = Math.max(
		0,
		...[...normalizedRoles].map((role) => roleRank(role)),
	);

	for (const role of gate.noneOf ?? []) {
		if (normalizedRoles.has(normalizeGateRole(role))) {
			return false;
		}
	}

	if (gate.minRole && highestRank < roleRank(gate.minRole)) {
		return false;
	}

	const anyOf = [...(gate.roles ?? []), ...(gate.anyOf ?? [])];
	if (
		anyOf.length > 0 &&
		!anyOf.some((role) => normalizedRoles.has(normalizeGateRole(role)))
	) {
		return false;
	}

	if (
		gate.allOf?.length &&
		!gate.allOf.every((role) => normalizedRoles.has(normalizeGateRole(role)))
	) {
		return false;
	}

	return true;
}
