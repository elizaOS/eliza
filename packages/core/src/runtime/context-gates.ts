/**
 * Role and context gate predicates for provider and action visibility. Decides
 * whether a caller's roles satisfy a `RoleGate` (min-rank plus anyOf/allOf/noneOf)
 * and whether the active agent contexts satisfy a `ContextGate`, and filters a
 * candidate list by both. Role and context names are normalized before every
 * comparison.
 */
import { CANONICAL_ROLE_RANK } from "../roles";
import type { Provider } from "../types/components";
import type {
	AgentContext,
	ContextGate,
	RoleGate,
	RoleGateRole,
} from "../types/contexts";
import { resolveProviderContexts } from "../utils/context-catalog";
import { normalizeContextList } from "./context-normalization";

// #9948: single source of truth for role ranking — delegates to CANONICAL_ROLE_RANK.
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

/**
 * True when the provider declares any context surface at all — a non-empty
 * `contexts` list or a `contextGate` with contexts/anyOf/allOf/noneOf. Providers
 * without one fall back to the static catalog and ultimately the "general"
 * context at the selection layer (see resolveProviderContextGate).
 */
export function providerDeclaresContextSurface(provider: Provider): boolean {
	const gate = provider.contextGate;
	return Boolean(
		provider.contexts?.length ||
			gate?.contexts?.length ||
			gate?.anyOf?.length ||
			gate?.allOf?.length ||
			gate?.noneOf?.length,
	);
}

/**
 * Effective context gate for a provider at the v5 selection layer. A declared
 * gate is honored in full — including anyOf/allOf/noneOf, which the generic
 * candidate filter cannot carry — with the #12087 Item 14 rule that an explicit
 * contextGate never shadows the provider's top-level roleGate. A provider that
 * declares no context surface resolves through the static catalog and defaults
 * to the "general" context: composed on ordinary chat turns, skipped on narrow
 * tool/planner contexts. Plugin registration (plugin-lifecycle) materializes
 * the same resolution onto `contexts`; this resolver keeps the selection layer
 * lean-by-default even for providers that bypass the wrapped registration
 * path, so an undeclared provider never rides every planner turn.
 */
export function resolveProviderContextGate(provider: Provider): ContextGate {
	const explicit = provider.contextGate;
	if (!providerDeclaresContextSurface(provider)) {
		return {
			contexts: resolveProviderContexts(provider),
			roleGate: explicit?.roleGate ?? provider.roleGate,
		};
	}
	return {
		...explicit,
		contexts: explicit?.contexts ?? provider.contexts,
		roleGate: explicit?.roleGate ?? provider.roleGate,
	};
}

/** Filter providers by their effective context gate (resolveProviderContextGate). */
export function filterProvidersByContextGate<T extends Provider>(
	providers: readonly T[],
	activeContexts: readonly AgentContext[] | undefined,
	userRoles?: readonly RoleGateRole[],
): T[] {
	return providers.filter((provider) =>
		satisfiesContextGate(
			activeContexts,
			resolveProviderContextGate(provider),
			userRoles,
		),
	);
}
