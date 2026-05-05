import type {
	IAgentRuntime,
	SearchCategoryRegistration,
} from "@elizaos/core";

export const SKILLS_SEARCH_CATEGORY: SearchCategoryRegistration = {
	category: "skills",
	label: "Agent skills",
	description:
		"Search the Agent Skills registry for available and installed skills.",
	contexts: ["system", "knowledge"],
	filters: [
		{ name: "query", label: "Query", type: "string", required: true },
		{
			name: "limit",
			label: "Limit",
			description: "Maximum skills to return.",
			type: "number",
			default: 10,
		},
		{
			name: "forceRefresh",
			label: "Force refresh",
			description: "Bypass the search result cache.",
			type: "boolean",
			default: false,
		},
		{
			name: "notOlderThan",
			label: "Cache TTL",
			description: "Maximum cache age in milliseconds.",
			type: "number",
		},
	],
	resultSchemaSummary:
		"SkillSearchResult[] enriched with installed, enabled, state, and action chips for use/enable/disable/install/copy/details.",
	capabilities: ["registry", "skills", "install-discovery", "cache"],
	source: "plugin:agent-skills",
	serviceType: "AGENT_SKILLS_SERVICE",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
	try {
		runtime.getSearchCategory(category, { includeDisabled: true });
		return true;
	} catch {
		return false;
	}
}

export function registerAgentSkillsSearchCategory(
	runtime: IAgentRuntime,
): void {
	if (!hasSearchCategory(runtime, SKILLS_SEARCH_CATEGORY.category)) {
		runtime.registerSearchCategory(SKILLS_SEARCH_CATEGORY);
	}
}
