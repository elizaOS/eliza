/**
 * SKILL — parent action that consolidates the agent-skills management
 * surface into one entry point.
 *
 * Note: USE_SKILL stays separate. It's the canonical, contractually-stable
 * entry point for invoking a specific skill (see workspace CLAUDE.md). This
 * action covers the management/lifecycle ops only: search, details, sync,
 * toggle, install, uninstall.
 */
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { getSkillDetailsAction } from "./get-skill-details";
import { installSkillAction } from "./install-skill";
import { searchSkillsAction } from "./search-skills";
import { syncCatalogAction } from "./sync-catalog";
import { toggleSkillAction } from "./toggle-skill";
import { uninstallSkillAction } from "./uninstall-skill";

type SkillOp =
	| "search"
	| "details"
	| "sync"
	| "toggle"
	| "install"
	| "uninstall";

const ALL_OPS: readonly SkillOp[] = [
	"search",
	"details",
	"sync",
	"toggle",
	"install",
	"uninstall",
] as const;

interface SkillRoute {
	op: SkillOp;
	action: Action;
	match: RegExp;
}

const ROUTES: SkillRoute[] = [
	{
		op: "uninstall",
		action: uninstallSkillAction,
		match: /\b(uninstall|remove|delete)\b.*\bskill\b/i,
	},
	{
		op: "install",
		action: installSkillAction,
		match: /\b(install|add)\b.*\bskill\b/i,
	},
	{
		op: "toggle",
		action: toggleSkillAction,
		match: /\b(enable|disable|activate|deactivate|toggle|turn on|turn off)\b.*\bskill\b/i,
	},
	{
		op: "sync",
		action: syncCatalogAction,
		match: /\b(sync|refresh|reload|update)\b.*\b(catalog|registry|skills?)\b/i,
	},
	{
		op: "details",
		action: getSkillDetailsAction,
		match: /\b(detail|info|describe|show|what is)\b.*\bskill\b/i,
	},
	{
		op: "search",
		action: searchSkillsAction,
		match: /\b(search|find|browse|list|available|catalog)\b.*\bskill\b|\bskills?\b.*\b(search|find|browse|list|available)\b/i,
	},
];

function readOptions(
	options?: HandlerOptions | Record<string, unknown>,
): Record<string, unknown> {
	const direct = (options ?? {}) as Record<string, unknown>;
	const parameters =
		direct.parameters && typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	return { ...direct, ...parameters };
}

function normalizeOp(value: unknown): SkillOp | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	if ((ALL_OPS as readonly string[]).includes(trimmed)) {
		return trimmed as SkillOp;
	}
	// Common aliases
	if (trimmed === "get" || trimmed === "info" || trimmed === "describe") {
		return "details";
	}
	if (trimmed === "enable" || trimmed === "disable") {
		return "toggle";
	}
	if (trimmed === "refresh" || trimmed === "update") {
		return "sync";
	}
	if (trimmed === "list" || trimmed === "browse") {
		return "search";
	}
	return null;
}

function selectRoute(
	message: Memory,
	options?: HandlerOptions | Record<string, unknown>,
): SkillRoute | null {
	const opts = readOptions(options);
	const requested = normalizeOp(opts.op ?? opts.subaction);
	if (requested) {
		const route = ROUTES.find((candidate) => candidate.op === requested);
		if (route) return route;
	}
	const text = typeof message.content?.text === "string" ? message.content.text : "";
	return ROUTES.find((route) => route.match.test(text)) ?? null;
}

export const skillAction: Action = {
	name: "SKILL",
	description:
		"Manage skill catalog. Operations: search (browse available skills), details (info about a specific skill), sync (refresh catalog from registry), toggle (enable/disable installed skill), install (install from registry), uninstall (remove non-bundled skill). For invoking an enabled skill, use USE_SKILL instead.",
	descriptionCompressed:
		"Skill catalog: search, details, sync, toggle, install, uninstall.",
	contexts: ["automation", "knowledge", "settings", "connectors"],
	contextGate: { anyOf: ["automation", "knowledge", "settings", "connectors"] },
	similes: [],
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "op",
			description:
				"Operation to perform. One of: search, details, sync, toggle, install, uninstall. Inferred from message text when omitted.",
			required: false,
			schema: { type: "string", enum: [...ALL_OPS] },
		},
	],
	validate: async (runtime: IAgentRuntime) => {
		return Boolean(runtime.getService("AGENT_SKILLS_SERVICE"));
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const route = selectRoute(message, options);
		if (!route) {
			const ops = ALL_OPS.join(", ");
			const text = `SKILL could not determine the operation. Specify one of: ${ops}.`;
			await callback?.({ text, source: message.content?.source });
			return {
				success: false,
				text,
				values: { error: "MISSING" },
				data: { actionName: "SKILL", availableOps: ops },
			};
		}
		const result =
			(await route.action.handler(runtime, message, state, options, callback)) ??
			({ success: true } as ActionResult);
		return {
			...result,
			data: {
				...(typeof result.data === "object" && result.data ? result.data : {}),
				actionName: "SKILL",
				routedActionName: route.action.name,
				op: route.op,
			},
		};
	},
	examples: [
		[
			{ name: "{{user1}}", content: { text: "Search skills for image generation" } },
			{
				name: "{{agentName}}",
				content: { text: "Searching the skill catalog.", actions: ["SKILL"] },
			},
		],
		[
			{ name: "{{user1}}", content: { text: "Install the github skill" } },
			{
				name: "{{agentName}}",
				content: { text: "Installing that skill.", actions: ["SKILL"] },
			},
		],
		[
			{ name: "{{user1}}", content: { text: "Disable the apple-notes skill" } },
			{
				name: "{{agentName}}",
				content: { text: "Disabling that skill.", actions: ["SKILL"] },
			},
		],
		[
			{ name: "{{user1}}", content: { text: "Refresh the skill catalog" } },
			{
				name: "{{agentName}}",
				content: { text: "Refreshing.", actions: ["SKILL"] },
			},
		],
	],
};
