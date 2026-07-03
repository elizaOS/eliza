import { CANONICAL_ROLE_RANK } from "../roles";
import type {
	AgentContext,
	ContextGate,
	RoleGate,
	RoleGateRole,
} from "../types/contexts";
import { normalizeContextList } from "./context-normalization";

// #9948: single source of truth for role ranking (was a duplicate literal here).
const ROLE_RANK: Record<string, number> = CANONICAL_ROLE_RANK;

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
		// #12087 Item 14: an explicit contextGate must NOT shadow the item's
		// top-level roleGate. A contextGate adds context requirements; it does not
		// waive the declared role requirement. Fall back to item.roleGate whenever the
		// contextGate does not specify its own.
		const explicit = item.contextGate;
		const gate: ContextGate = {
			contexts: explicit?.contexts ?? item.contexts,
			roleGate: explicit?.roleGate ?? item.roleGate,
		};
		return satisfiesContextGate(activeContexts, gate, userRoles);
	});
}
