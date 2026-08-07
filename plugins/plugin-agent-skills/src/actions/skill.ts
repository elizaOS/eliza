/**
 * Routes local skill-management requests through the stable SKILL parent
 * action. USE_SKILL remains the separate invocation contract.
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
import { unwrapUserMessageText } from "@elizaos/core";
import { toggleSkillAction } from "./toggle-skill";
import { uninstallSkillAction } from "./uninstall-skill";

type SkillOp = "toggle" | "uninstall";

const ALL_OPS: readonly SkillOp[] = ["toggle", "uninstall"];

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
		op: "toggle",
		action: toggleSkillAction,
		match: /\b(enable|disable|activate|deactivate|toggle|turn on|turn off)\b.*\bskill\b/i,
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
	if (trimmed === "enable" || trimmed === "disable") return "toggle";
	if (trimmed === "remove" || trimmed === "delete") return "uninstall";
	return null;
}

function selectRoute(
	message: Memory,
	options?: HandlerOptions | Record<string, unknown>,
): SkillRoute | null {
	const requested = normalizeOp(readOptions(options).action);
	if (requested) {
		return ROUTES.find((candidate) => candidate.op === requested) ?? null;
	}
	const text = unwrapUserMessageText(message);
	return ROUTES.find((route) => route.match.test(text)) ?? null;
}

export const skillAction: Action = {
	name: "SKILL",
	description:
		"Manage installed skills. Ops: toggle and uninstall. Use USE_SKILL to invoke an enabled skill.",
	descriptionCompressed: "Installed skills: toggle or uninstall.",
	contexts: ["automation", "knowledge", "settings", "connectors"],
	contextGate: { anyOf: ["automation", "knowledge", "settings", "connectors"] },
	similes: [
		"MANAGE_SKILL",
		"MANAGE_SKILLS",
		"SKILLS",
		"AGENT_SKILL",
		"AGENT_SKILLS",
		"UNINSTALL_SKILL",
		"TOGGLE_SKILL",
	],
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "action",
			description: "Operation: toggle or uninstall. Infer if omitted.",
			required: false,
			schema: { type: "string", enum: [...ALL_OPS] },
		},
		{
			name: "slug",
			description: "Installed skill slug.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "enabled",
			description: "For action=toggle: true enables; false disables.",
			required: false,
			schema: { type: "boolean" },
		},
	],
	validate: async (runtime: IAgentRuntime) =>
		Boolean(runtime.getService("AGENT_SKILLS_SERVICE")),
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const route = selectRoute(message, options);
		if (!route) {
			const text = `SKILL could not determine the operation. Specify one of: ${ALL_OPS.join(", ")}.`;
			await callback?.({ text, source: message.content.source });
			return {
				success: false,
				text,
				values: { error: "MISSING" },
				data: { actionName: "SKILL", availableOps: [...ALL_OPS] },
			};
		}
		const routedCallback: HandlerCallback | undefined = callback
			? (response, actionName) =>
					callback(response, actionName ?? route.action.name)
			: undefined;
		const result =
			(await route.action.handler(
				runtime,
				message,
				state,
				options,
				routedCallback,
			)) ?? ({ success: true } as ActionResult);
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
			{ name: "{{user1}}", content: { text: "Disable the apple-notes skill" } },
			{
				name: "{{agentName}}",
				content: { text: "Disabling that skill.", actions: ["SKILL"] },
			},
		],
	],
};
