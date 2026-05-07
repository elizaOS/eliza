import type {
	AgentContext,
	ContextDefinition,
	FirstPartyAgentContext,
	RoleGateRole,
} from "../types/contexts";
import { satisfiesRoleGate } from "./context-gates";
import { DEFAULT_CONTEXT_DEFINITIONS } from "./default-contexts";

export const FIRST_PARTY_CONTEXT_IDS = [
	"simple",
	"general",
	"memory",
	"knowledge",
	"web",
	"browser",
	"code",
	"files",
	"terminal",
	"email",
	"calendar",
	"contacts",
	"tasks",
	"health",
	"screen_time",
	"subscriptions",
	"finance",
	"payments",
	"wallet",
	"crypto",
	"messaging",
	"social_posting",
	"media",
	"automation",
	"connectors",
	"settings",
	"secrets",
	"admin",
	"agent_internal",
] as const satisfies readonly FirstPartyAgentContext[];

const LIFEOPS_ALIAS_CONTEXTS = [
	"email",
	"calendar",
	"contacts",
	"tasks",
	"health",
	"screen_time",
	"subscriptions",
	"finance",
	"payments",
	"wallet",
	"crypto",
	"messaging",
	"social_posting",
	"automation",
	"connectors",
] as const satisfies readonly FirstPartyAgentContext[];

export const CONTEXT_ALIASES: Readonly<
	Record<string, readonly AgentContext[]>
> = Object.freeze({
	lifeops: LIFEOPS_ALIAS_CONTEXTS,
	money: ["finance", "wallet", "crypto"],
	balance: ["finance", "wallet", "crypto"],
	balances: ["finance", "wallet", "crypto"],
	portfolio: ["finance", "wallet", "crypto"],
	web3: ["crypto", "wallet", "finance"],
	defi: ["crypto", "wallet", "finance"],
	social: ["social_posting"],
	system: ["admin", "settings"],
});

/**
 * Canonical first-party context definitions.
 *
 * The list lives in `./default-contexts` (PLAN.md §4.3 taxonomy with role
 * gates). This export is kept for backward compatibility; the source of truth
 * is `DEFAULT_CONTEXT_DEFINITIONS`.
 */
export const FIRST_PARTY_CONTEXT_DEFINITIONS: readonly ContextDefinition[] =
	DEFAULT_CONTEXT_DEFINITIONS;

export class ContextRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContextRegistryError";
	}
}

export function normalizeContextId(context: string): AgentContext {
	return context
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_") as AgentContext;
}

export function expandContextAliases(context: AgentContext): AgentContext[] {
	const normalized = normalizeContextId(context);
	const alias = CONTEXT_ALIASES[normalized];
	if (!alias) {
		return [normalized];
	}
	return alias.map((value) => normalizeContextId(value));
}

export function normalizeContextList(
	contexts: readonly AgentContext[] | undefined,
): AgentContext[] {
	if (!contexts?.length) {
		return [];
	}
	const normalized = new Set<AgentContext>();
	for (const context of contexts) {
		for (const expanded of expandContextAliases(context)) {
			normalized.add(expanded);
		}
	}
	return [...normalized];
}

export class ContextRegistry {
	readonly #definitions = new Map<AgentContext, ContextDefinition>();

	constructor(
		definitions: readonly ContextDefinition[] = FIRST_PARTY_CONTEXT_DEFINITIONS,
	) {
		this.registerMany(definitions);
	}

	list(): ContextDefinition[] {
		return [...this.#definitions.values()];
	}

	get(context: AgentContext): ContextDefinition | undefined {
		return this.#definitions.get(normalizeContextId(context));
	}

	has(context: AgentContext): boolean {
		return this.#definitions.has(normalizeContextId(context));
	}

	register(definition: ContextDefinition): void {
		this.registerMany([definition]);
	}

	registerMany(definitions: readonly ContextDefinition[]): void {
		const next = new Map(this.#definitions);
		for (const definition of definitions) {
			const normalized = normalizeDefinition(definition);
			if (next.has(normalized.id)) {
				throw new ContextRegistryError(
					`Duplicate context definition: ${normalized.id}`,
				);
			}
			next.set(normalized.id, normalized);
		}
		assertNoUnknownEdges(next);
		assertNoContextCycles(next);
		this.#definitions.clear();
		for (const [id, definition] of next) {
			this.#definitions.set(id, definition);
		}
	}

	/**
	 * Idempotent registration. Returns true when the definition was added,
	 * false when an entry with the same id already existed and was kept.
	 *
	 * Used by the runtime startup wiring to register the first-party context
	 * taxonomy without throwing if a plugin already registered the same id.
	 */
	tryRegister(definition: ContextDefinition): boolean {
		const normalized = normalizeDefinition(definition);
		if (this.#definitions.has(normalized.id)) {
			return false;
		}
		this.registerMany([definition]);
		return true;
	}

	/**
	 * Idempotent batch registration. Skips entries whose id is already
	 * registered (returning their ids in `skipped`), and inserts the remainder
	 * atomically through `registerMany` so cross-references between the new
	 * definitions resolve correctly.
	 *
	 * Used by the runtime startup wiring to seed the first-party context
	 * taxonomy without choking on subcontext edges.
	 */
	tryRegisterMany(definitions: readonly ContextDefinition[]): {
		added: AgentContext[];
		skipped: AgentContext[];
	} {
		const added: AgentContext[] = [];
		const skipped: AgentContext[] = [];
		const toAdd: ContextDefinition[] = [];
		for (const definition of definitions) {
			const normalized = normalizeDefinition(definition);
			if (this.#definitions.has(normalized.id)) {
				skipped.push(normalized.id);
				continue;
			}
			toAdd.push(definition);
			added.push(normalized.id);
		}
		if (toAdd.length > 0) {
			this.registerMany(toAdd);
		}
		return { added, skipped };
	}

	/**
	 * Return all context definitions whose role gate (if any) is satisfied by
	 * the supplied caller role(s). Contexts without a role gate are always
	 * included. The order matches `list()` for stable prompt rendering.
	 */
	listAvailable(
		roles: RoleGateRole | readonly RoleGateRole[] | undefined,
	): ContextDefinition[] {
		const normalizedRoles =
			roles === undefined
				? []
				: Array.isArray(roles)
					? (roles as readonly RoleGateRole[])
					: [roles as RoleGateRole];
		return this.list().filter((definition) =>
			satisfiesRoleGate(normalizedRoles, definition.roleGate),
		);
	}

	normalize(context: AgentContext): AgentContext {
		return normalizeContextId(context);
	}

	normalizeList(contexts: readonly AgentContext[] | undefined): AgentContext[] {
		return normalizeContextList(contexts);
	}
}

function normalizeDefinition(definition: ContextDefinition): ContextDefinition {
	return {
		...definition,
		id: normalizeContextId(definition.id),
		parent: definition.parent
			? normalizeContextId(definition.parent)
			: undefined,
		parents: normalizeContextList(definition.parents),
		subcontexts: normalizeContextList(definition.subcontexts),
		aliases: definition.aliases?.map((alias) => normalizeContextId(alias)),
	};
}

function getEdges(
	definitions: ReadonlyMap<AgentContext, ContextDefinition>,
): Map<AgentContext, AgentContext[]> {
	const edges = new Map<AgentContext, AgentContext[]>();
	for (const [id, definition] of definitions) {
		const targets = new Set<AgentContext>();
		for (const parent of [
			definition.parent,
			...(definition.parents ?? []),
		].filter(Boolean) as AgentContext[]) {
			const parentTargets = edges.get(parent) ?? [];
			parentTargets.push(id);
			edges.set(parent, parentTargets);
		}
		for (const subcontext of definition.subcontexts ?? []) {
			targets.add(subcontext);
		}
		edges.set(id, [...(edges.get(id) ?? []), ...targets]);
	}
	return edges;
}

function assertNoUnknownEdges(
	definitions: ReadonlyMap<AgentContext, ContextDefinition>,
): void {
	for (const [id, definition] of definitions) {
		const referenced = [
			definition.parent,
			...(definition.parents ?? []),
			...(definition.subcontexts ?? []),
		].filter(Boolean) as AgentContext[];
		for (const context of referenced) {
			if (!definitions.has(context)) {
				throw new ContextRegistryError(
					`Context ${id} references unknown context ${context}`,
				);
			}
		}
	}
}

function assertNoContextCycles(
	definitions: ReadonlyMap<AgentContext, ContextDefinition>,
): void {
	const edges = getEdges(definitions);
	const visiting = new Set<AgentContext>();
	const visited = new Set<AgentContext>();

	function visit(id: AgentContext, path: AgentContext[]): void {
		if (visiting.has(id)) {
			throw new ContextRegistryError(
				`Context cycle detected: ${[...path, id].join(" -> ")}`,
			);
		}
		if (visited.has(id)) {
			return;
		}
		visiting.add(id);
		for (const target of edges.get(id) ?? []) {
			visit(target, [...path, id]);
		}
		visiting.delete(id);
		visited.add(id);
	}

	for (const id of definitions.keys()) {
		visit(id, []);
	}
}

export const defaultContextRegistry = new ContextRegistry();
