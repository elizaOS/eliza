/**
 * Search Skills Action
 *
 * Searches the skill registry and returns results enriched with structured
 * action chips so the UI can render Enable/Disable/Use/Copy/Install buttons
 * per result, and the LLM can suggest the right follow-up action by name.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";
import type { CacheOptions, SkillSearchResult } from "../types";
import { createAgentSkillsActionValidator } from "./validators";

export type SkillResultActionKind =
	| "use"
	| "enable"
	| "disable"
	| "install"
	| "uninstall"
	| "copy"
	| "details";

export interface SkillResultAction {
	kind: SkillResultActionKind;
	label: string;
	target: string;
}

export type SkillSearchInstalledState =
	| "enabled"
	| "disabled"
	| "not-installed";

export interface SkillSearchResultWithActions extends SkillSearchResult {
	installed: boolean;
	enabled: boolean;
	state: SkillSearchInstalledState;
	actions: SkillResultAction[];
}

function buildResultActions(
	slug: string,
	state: SkillSearchInstalledState,
): SkillResultAction[] {
	const detailsAction: SkillResultAction = {
		kind: "details",
		label: "View details",
		target: slug,
	};
	const copyAction: SkillResultAction = {
		kind: "copy",
		label: "Copy SKILL.md",
		target: slug,
	};

	switch (state) {
		case "enabled":
			return [
				{ kind: "use", label: "Use", target: slug },
				{ kind: "disable", label: "Disable", target: slug },
				copyAction,
				detailsAction,
			];
		case "disabled":
			return [
				{ kind: "enable", label: "Enable", target: slug },
				copyAction,
				detailsAction,
				{ kind: "uninstall", label: "Uninstall", target: slug },
			];
		case "not-installed":
			return [
				{ kind: "install", label: "Install", target: slug },
				detailsAction,
			];
	}
}

function describeChips(actions: SkillResultAction[]): string {
	// Mention the action verbs so an LLM rendering this output can pick the
	// right parent action + op for the follow-up.
	const map: Record<SkillResultActionKind, string> = {
		use: "USE_SKILL",
		enable: "SKILL op=toggle enabled=true",
		disable: "SKILL op=toggle enabled=false",
		install: "SKILL op=install",
		uninstall: "SKILL op=uninstall",
		copy: "Copy SKILL.md",
		details: "SKILL op=details",
	};
	return actions.map((a) => map[a.kind]).join(" · ");
}

export async function runSkillSearch(
	service: AgentSkillsService,
	query: string,
	limit = 10,
	options: CacheOptions = {},
): Promise<ActionResult> {
	const normalizedQuery = query.trim();
	const results = await service.search(normalizedQuery, limit, options);

	if (results.length === 0) {
		const text = [
			"skills_search:",
			`  query: ${normalizedQuery}`,
			"  resultCount: 0",
			"results[0]:",
		].join("\n");
		return {
			success: true,
			text,
			values: { resultCount: 0, category: "skills" },
			data: {
				actionName: "SEARCH",
				category: "skills",
				query: normalizedQuery,
				results: [] as SkillSearchResultWithActions[],
			},
		};
	}

	const enriched: SkillSearchResultWithActions[] = results.map((r) => {
		const loaded = service.getLoadedSkill(r.slug);
		const installed = Boolean(loaded);
		const enabled = installed && service.isSkillEnabled(r.slug);
		const state: SkillSearchInstalledState = !installed
			? "not-installed"
			: enabled
				? "enabled"
				: "disabled";
		return {
			...r,
			installed,
			enabled,
			state,
			actions: buildResultActions(r.slug, state),
		};
	});

	const lines = [
		"skills_search:",
		`  query: ${normalizedQuery}`,
		`  resultCount: ${enriched.length}`,
		`results[${enriched.length}]{slug,displayName,state,summary,actions}:`,
		...enriched.map((result) =>
			[
				`  ${result.slug}`,
				result.displayName,
				result.state,
				result.summary.replace(/\s+/g, " ").trim(),
				describeChips(result.actions),
			].join(","),
		),
		"next_actions:",
		"  use: USE_SKILL for enabled skills",
		"  toggle: SKILL op=toggle for installed skills",
		"  install: SKILL op=install for not-installed skills",
		"  details: SKILL op=details for a selected slug",
	];

	return {
		success: true,
		text: lines.join("\n"),
		values: { resultCount: enriched.length, category: "skills" },
		data: {
			actionName: "SEARCH",
			category: "skills",
			query: normalizedQuery,
			results: enriched,
		},
	};
}

export const searchSkillsAction = {
	name: "SKILL",
	contexts: ["knowledge", "automation", "settings"],
	contextGate: { anyOf: ["knowledge", "automation", "settings"] },
	roleGate: { minRole: "USER" },
	similes: ["BROWSE_SKILLS", "LIST_SKILLS", "FIND_SKILLS"],
	description:
		"Search the skill registry for available skills by keyword or category. Returns each result with action chips (use/enable/disable/install/copy/details).",
	descriptionCompressed:
		"Search skill registry by keyword/category; returns action chips.",
	validate: createAgentSkillsActionValidator({
		keywords: ["search", "find", "browse", "list", "skill"],
		regex:
			/\b(?:search|find|browse|list)\b.*\bskills?\b|\bskills?\b.*\b(?:search|find|browse|list)\b/i,
	}),

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const service = runtime.getService<AgentSkillsService>(
			"AGENT_SKILLS_SERVICE",
		);
		if (!service) {
			const errorText = "AgentSkillsService not available.";
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const opts = options as
			| { parameters?: { query?: unknown; limit?: unknown } }
			| undefined;
		const query =
			typeof opts?.parameters?.query === "string"
				? opts.parameters.query
				: message.content?.text || "";
		const limit =
			typeof opts?.parameters?.limit === "number" &&
			Number.isFinite(opts.parameters.limit)
				? Math.max(1, Math.floor(opts.parameters.limit))
				: 10;
		const result = await runSkillSearch(service, query, limit);
		const text = result.text ?? "";
		if (callback) await callback({ text });

		return result;
	},

	parameters: [
		{
			name: "query",
			description: "Search query or skill category.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "limit",
			description: "Maximum number of skill results.",
			required: false,
			schema: { type: "number" as const },
		},
	],

	examples: [
		[
			{
				name: "{{userName}}",
				content: { text: "Search for skills about data analysis" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: '## Skills matching "data analysis"\n\n1. **Data Analysis** (`data-analysis`) [not installed]\n   Analyze datasets and generate insights\n   → SKILL op=install · SKILL op=details',
					actions: ["SKILL"],
				},
			},
		],
	],
} satisfies Action;

export default searchSkillsAction;
