import { ROLE_RANK as CANONICAL_ROLE_RANK } from "../roles";
import type {
	AgentContext,
	ContextGate,
	RoleGate,
	RoleGateRole,
} from "../types/contexts";
import { normalizeContextList } from "./context-normalization";

// The gate vocabulary has two tiers the canonical 4-tier role model
// (GUEST<USER<ADMIN<OWNER, see packages/core/src/roles.ts) does not: NONE,
// which sits below GUEST, and MEMBER, which is an alias for USER. We derive the
// gate ranks directly from the canonical table — shifting every canonical tier
// up by one so NONE can occupy rank 0 — so the two tables can never silently
// disagree on the shared members. (Values are identical to the previous literal
// table: NONE 0, GUEST 1, USER/MEMBER 2, ADMIN 3, OWNER 4.)
const CANONICAL_RANK_OFFSET = 1;
const ROLE_RANK: Record<string, number> = {
	NONE: 0,
	GUEST: CANONICAL_ROLE_RANK.GUEST + CANONICAL_RANK_OFFSET,
	USER: CANONICAL_ROLE_RANK.USER + CANONICAL_RANK_OFFSET,
	MEMBER: CANONICAL_ROLE_RANK.USER + CANONICAL_RANK_OFFSET,
	ADMIN: CANONICAL_ROLE_RANK.ADMIN + CANONICAL_RANK_OFFSET,
	OWNER: CANONICAL_ROLE_RANK.OWNER + CANONICAL_RANK_OFFSET,
};

export function normalizeGateRole(role: RoleGateRole): RoleGateRole {
	const normalized = String(role).trim().toUpperCase();
	return (normalized === "USER" ? "MEMBER" : normalized) as RoleGateRole;
}

export function roleRank(role: RoleGateRole): number {
	return ROLE_RANK[String(normalizeGateRole(role))] ?? 0;
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

export function satisfiesContextGate(
	activeContexts: readonly AgentContext[] | undefined,
	gate: ContextGate | undefined,
	userRoles?: readonly RoleGateRole[],
): boolean {
	if (!gate) {
		return satisfiesRoleGate(userRoles, undefined);
	}
	if (!satisfiesRoleGate(userRoles, gate.roleGate)) {
		return false;
	}

	const active = new Set(normalizeContextList(activeContexts));

	const denied = normalizeContextList(gate.noneOf);
	if (denied.some((context) => active.has(context))) {
		return false;
	}

	const required = normalizeContextList(gate.allOf);
	if (
		required.length > 0 &&
		!required.every((context) => active.has(context))
	) {
		return false;
	}

	const anyOf = normalizeContextList([
		...(gate.contexts ?? []),
		...(gate.anyOf ?? []),
	]);
	if (anyOf.length === 0) {
		return true;
	}

	return anyOf.some((context) => active.has(context));
}

export interface ContextGateCandidate {
	contexts?: AgentContext[];
	contextGate?: ContextGate;
	roleGate?: RoleGate;
}

export function filterByContextGate<T extends ContextGateCandidate>(
	items: readonly T[],
	activeContexts: readonly AgentContext[] | undefined,
	userRoles?: readonly RoleGateRole[],
): T[] {
	return items.filter((item) => {
		const gate: ContextGate | undefined = item.contextGate ?? {
			contexts: item.contexts,
			roleGate: item.roleGate,
		};
		return satisfiesContextGate(activeContexts, gate, userRoles);
	});
}
