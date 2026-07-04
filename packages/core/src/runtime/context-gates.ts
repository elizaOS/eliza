/**
 * Role and context gate predicates for provider and action visibility. Decides
 * whether a caller's roles satisfy a `RoleGate` (min-rank plus anyOf/allOf/noneOf)
 * and whether the active agent contexts satisfy a `ContextGate`, and filters a
 * candidate list by both. Role and context names are normalized before every
 * comparison.
 */
import { CANONICAL_ROLE_RANK } from "../roles";
import type {
	AgentContext,
	ContextGate,
	RoleGate,
	RoleGateRole,
} from "../types/contexts";
import { lookupProviderCatalogContexts } from "../utils/context-catalog.ts";
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

/** A provider-shaped gate candidate: the name enables the catalog fallback. */
export interface ProviderContextGateCandidate extends ContextGateCandidate {
	name: string;
}

/**
 * The effective context gate a provider declared, in full (#13203). A declared
 * `contextGate` with any context terms (contexts/anyOf/allOf/noneOf) is honored
 * verbatim — `filterByContextGate`'s `{contexts, roleGate}` reduction silently
 * dropped anyOf/allOf/noneOf, so a world-style `contextGate: { anyOf: [...] }`
 * provider lost its gate on the v5 planner selection path. Providers declaring
 * no gate terms resolve declared `contexts` → catalog (PROVIDER_CONTEXT_MAP);
 * a provider with neither declares no routing at all, and stays UNGATED
 * (#13204 follow-up): the pre-#13203 selection filter included that class on
 * every turn, and an injected `["general"]` here would silently drop
 * undeclared plugin providers (TWITTER_IDENTITY-shaped) from the narrow turns
 * they rode before. Only an explicit declaration or catalog entry may gate a
 * provider out; the wrapped registration path still materializes the
 * `["general"]` lean onto `contexts` (plugin-lifecycle), which this resolver
 * honors as declared.
 *
 * #12087 Item 14 preserved: a contextGate adds context requirements; it does
 * not waive the provider's top-level roleGate unless it declares its own.
 */
export function resolveProviderContextGate(
	provider: ProviderContextGateCandidate,
): ContextGate {
	const explicit = provider.contextGate;
	const roleGate = explicit?.roleGate ?? provider.roleGate;
	const declaresContextTerms =
		(explicit?.contexts?.length ?? 0) > 0 ||
		(explicit?.anyOf?.length ?? 0) > 0 ||
		(explicit?.allOf?.length ?? 0) > 0 ||
		(explicit?.noneOf?.length ?? 0) > 0;

	if (explicit && declaresContextTerms) {
		return {
			contexts: explicit.contexts,
			anyOf: explicit.anyOf,
			allOf: explicit.allOf,
			noneOf: explicit.noneOf,
			roleGate,
		};
	}

	const declared = (provider.contexts ?? []).filter((context) =>
		Boolean(context),
	);
	return {
		contexts:
			declared.length > 0
				? declared
				: lookupProviderCatalogContexts(provider.name),
		roleGate,
	};
}

/**
 * Filter providers by their FULL effective context gate (see
 * {@link resolveProviderContextGate}). The v5 planner selection uses this
 * instead of {@link filterByContextGate} so declared anyOf/allOf/noneOf terms
 * and the catalog fallback for undeclared providers are honored.
 */
export function filterProvidersByContextGate<
	T extends ProviderContextGateCandidate,
>(
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
