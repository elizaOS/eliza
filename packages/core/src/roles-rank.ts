/**
 * Pure role-rank table and predicates for UI/client use (#18056).
 *
 * Kept free of connectors/entities/logger so the app renderer can import
 * `ROLE_RANK` / `roleRank` without pulling the full `@elizaos/core` browser
 * prebuilt blob. `roles.ts` re-exports these so server authz stays aligned.
 */

export type RoleName = "OWNER" | "ADMIN" | "USER" | "GUEST";

/**
 * Canonical rank for every role tier — single source of truth (#9948).
 * `USER` and `MEMBER` are the same tier.
 */
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

/** Role vocabulary used by UI role gates (includes MEMBER alias). */
export type RoleGateRole =
	| RoleName
	| "MEMBER"
	| "NONE"
	| (string & {});

export function normalizeGateRole(role: RoleGateRole): string {
	const normalized = String(role).trim().toUpperCase();
	return normalized === "USER" ? "MEMBER" : normalized;
}

export function roleRank(role: RoleGateRole): number {
	return (
		CANONICAL_ROLE_RANK[
			normalizeGateRole(role) as keyof typeof CANONICAL_ROLE_RANK
		] ?? 0
	);
}

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

export function isAdminRank(role: string | undefined | null): boolean {
	return hasAtLeastRole(role, "ADMIN");
}

/** Minimal role gate shape used by UI `<RoleGate>` (subset of full RoleGate). */
export interface SimpleRoleGate {
	minRole?: RoleGateRole;
	anyOf?: RoleGateRole[];
	noneOf?: RoleGateRole[];
}

/**
 * Pure role-gate check for UI surfaces. Matches the min/any/none portion of
 * runtime `satisfiesRoleGate` without importing context-gates (#18056).
 */
export function satisfiesRoleGate(
	userRoles: readonly RoleGateRole[] | undefined,
	gate: SimpleRoleGate | undefined,
): boolean {
	if (!gate) return true;
	const normalizedRoles = new Set((userRoles ?? []).map(normalizeGateRole));
	const highestRank = Math.max(
		0,
		...[...normalizedRoles].map((role) => roleRank(role)),
	);
	for (const role of gate.noneOf ?? []) {
		if (normalizedRoles.has(normalizeGateRole(role))) return false;
	}
	if (gate.minRole && highestRank < roleRank(gate.minRole)) return false;
	if (gate.anyOf && gate.anyOf.length > 0) {
		return gate.anyOf.some((role) =>
			normalizedRoles.has(normalizeGateRole(role)),
		);
	}
	return true;
}
