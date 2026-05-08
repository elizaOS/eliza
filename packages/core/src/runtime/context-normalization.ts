import type { AgentContext, FirstPartyAgentContext } from "../types/contexts";

export const FIRST_PARTY_CONTEXT_IDS = [
	"simple",
	"general",
	"memory",
	"documents",
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

/**
 * Aliases for context names that aren't themselves canonical first-party
 * contexts but expand to one or more canonical contexts. Aliases are
 * intentionally narrow — `lifeops`, `social`, and `system` were retired
 * (callers now declare the canonical contexts directly); only convenience
 * aliases for finance/crypto remain.
 */
export const CONTEXT_ALIASES: Readonly<
	Record<string, readonly AgentContext[]>
> = Object.freeze({
	money: ["finance", "wallet", "crypto"],
	balance: ["finance", "wallet", "crypto"],
	balances: ["finance", "wallet", "crypto"],
	portfolio: ["finance", "wallet", "crypto"],
	web3: ["crypto", "wallet", "finance"],
	defi: ["crypto", "wallet", "finance"],
});

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
