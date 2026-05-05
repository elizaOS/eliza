import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	SearchCategoryRegistration,
	State,
} from "@elizaos/core";
import { runSkillSearch } from "./actions/search-skills";
import type { AgentSkillsService } from "./services/skills";

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

const PATCHED_SEARCH_ACTION = Symbol.for(
	"elizaos.agent-skills.search-action-patched",
);

type MutableSearchAction = Action & {
	[PATCHED_SEARCH_ACTION]?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCategory(value: unknown): string {
	return typeof value === "string"
		? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
		: "";
}

function readUnifiedSearchRequest(
	message: Memory,
	options?: HandlerOptions,
): {
	category: string;
	query: string;
	limit: number;
	forceRefresh: boolean;
	notOlderThan?: number;
} {
	const params = isRecord(options?.parameters)
		? (options?.parameters as Record<string, unknown>)
		: {};
	const filters = isRecord(params.filters)
		? (params.filters as Record<string, unknown>)
		: {};
	const content = isRecord(message.content)
		? (message.content as Record<string, unknown>)
		: {};
	const category = normalizeCategory(
		params.category ?? filters.category ?? content.category,
	);
	const queryValue = params.query ?? filters.query ?? content.query;
	const rawText =
		typeof message.content === "string"
			? message.content
			: typeof message.content?.text === "string"
				? message.content.text
				: "";
	const query =
		typeof queryValue === "string" && queryValue.trim().length > 0
			? queryValue.trim()
			: rawText.trim();
	const rawLimit = params.limit ?? filters.limit;
	const limit =
		typeof rawLimit === "number" && Number.isFinite(rawLimit)
			? Math.max(1, Math.min(50, Math.floor(rawLimit)))
			: 10;
	const forceRefresh =
		params.forceRefresh === true || filters.forceRefresh === true;
	const rawNotOlderThan = params.notOlderThan ?? filters.notOlderThan;
	const notOlderThan =
		typeof rawNotOlderThan === "number" && Number.isFinite(rawNotOlderThan)
			? rawNotOlderThan
			: undefined;
	return {
		category,
		query,
		limit,
		forceRefresh,
		...(notOlderThan !== undefined ? { notOlderThan } : {}),
	};
}

function isUnsupportedSkillsResult(result: ActionResult | undefined): boolean {
	const values = isRecord(result?.values) ? result?.values : {};
	const data = isRecord(result?.data) ? result?.data : {};
	return (
		normalizeCategory(values?.category ?? data?.category) === "skills" &&
		(values?.error === "UNSUPPORTED_CATEGORY" ||
			data?.error === "UNSUPPORTED_CATEGORY")
	);
}

async function dispatchUnifiedSkillsSearch(
	runtime: IAgentRuntime,
	message: Memory,
	options: HandlerOptions | undefined,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const service = runtime.getService<AgentSkillsService>(
		"AGENT_SKILLS_SERVICE",
	);
	if (!service) {
		const text = "AgentSkillsService not available.";
		await callback?.({ text });
		return {
			success: false,
			text,
			error: new Error(text),
			values: { error: "SERVICE_NOT_FOUND", category: "skills" },
			data: { actionName: "SEARCH", category: "skills" },
		};
	}

	const request = readUnifiedSearchRequest(message, options);
	const result = await runSkillSearch(service, request.query, request.limit, {
		forceRefresh: request.forceRefresh,
		...(request.notOlderThan !== undefined
			? { notOlderThan: request.notOlderThan }
			: {}),
	});
	if (result.text) {
		await callback?.({ text: result.text });
	}
	return result;
}

export function installAgentSkillsSearchDispatcher(
	runtime: IAgentRuntime,
): boolean {
	const searchAction = runtime.actions?.find(
		(action) => action.name === "SEARCH",
	) as MutableSearchAction | undefined;
	if (!searchAction?.handler || searchAction[PATCHED_SEARCH_ACTION]) {
		return false;
	}

	const originalHandler = searchAction.handler;
	searchAction.handler = async (
		runtimeArg: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
		responses?: Memory[],
	): Promise<ActionResult | undefined> => {
		const request = readUnifiedSearchRequest(message, options);
		if (request.category === "skills") {
			return dispatchUnifiedSkillsSearch(
				runtimeArg,
				message,
				options,
				callback,
			);
		}

		const result = await originalHandler(
			runtimeArg,
			message,
			state,
			options,
			callback,
			responses,
		);
		if (isUnsupportedSkillsResult(result)) {
			return dispatchUnifiedSkillsSearch(
				runtimeArg,
				message,
				options,
				callback,
			);
		}
		return result;
	};
	searchAction[PATCHED_SEARCH_ACTION] = true;
	return true;
}
