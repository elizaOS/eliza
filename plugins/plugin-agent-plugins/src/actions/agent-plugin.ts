/**
 * AGENT_PLUGIN — parent action for Agent Plugin package lifecycle.
 *
 * Ops: list, details, install, uninstall, reload.
 * Installing/uninstalling is local filesystem only. Remote URLs fail closed.
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
import { AgentPluginsService } from "../services/agent-plugins";
import { AGENT_PLUGINS_SERVICE_TYPE, type LoadedAgentPlugin } from "../types";

type PluginOp = "list" | "details" | "install" | "uninstall" | "reload";

const ALL_OPS: readonly PluginOp[] = [
	"list",
	"details",
	"install",
	"uninstall",
	"reload",
] as const;

interface PluginRoute {
	op: PluginOp;
	match: RegExp;
}

const ROUTES: PluginRoute[] = [
	{
		op: "uninstall",
		match: /\b(uninstall|remove|delete)\b.*\b(agent[- ]?plugin)/i,
	},
	{
		op: "install",
		match: /\b(install|add|load)\b.*\b(agent[- ]?plugin)/i,
	},
	{
		op: "reload",
		match: /\b(reload|refresh|rescan)\b.*\b(agent[- ]?plugin)/i,
	},
	{
		op: "details",
		match: /\b(detail|info|describe|show|what is)\b.*\b(agent[- ]?plugin)/i,
	},
	{
		op: "list",
		match: /\b(list|ls|show)\b.*\b(agent[- ]?plugins?)/i,
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

function normalizeOp(value: unknown): PluginOp | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	if ((ALL_OPS as readonly string[]).includes(trimmed)) {
		return trimmed as PluginOp;
	}
	if (trimmed === "get" || trimmed === "info" || trimmed === "describe") {
		return "details";
	}
	if (trimmed === "refresh" || trimmed === "rescan") return "reload";
	if (trimmed === "ls" || trimmed === "browse") return "list";
	if (trimmed === "add" || trimmed === "load") return "install";
	if (trimmed === "remove" || trimmed === "delete") return "uninstall";
	return null;
}

function selectOp(
	message: Memory,
	options?: HandlerOptions | Record<string, unknown>,
): PluginOp | null {
	const opts = readOptions(options);
	const requested = normalizeOp(opts.action);
	if (requested) return requested;
	const text = unwrapUserMessageText(message);
	return ROUTES.find((route) => route.match.test(text))?.op ?? null;
}

function getService(runtime: IAgentRuntime): AgentPluginsService | null {
	return runtime.getService<AgentPluginsService>(AGENT_PLUGINS_SERVICE_TYPE);
}

function summarize(plugin: LoadedAgentPlugin): string {
	const version = plugin.manifest.version ?? "unversioned";
	const skillCount = plugin.skills.length;
	const mcpCount = plugin.mcp.servers.length;
	const warnCount = plugin.warnings.length + plugin.mcp.invalidServers.length;
	return `${plugin.manifest.name}@${version} skills=${skillCount} mcp=${mcpCount} warnings=${warnCount}`;
}

async function reply(
	callback: HandlerCallback | undefined,
	message: Memory,
	text: string,
	success: boolean,
	data: Record<string, unknown>,
): Promise<ActionResult> {
	await callback?.({ text, source: message.content.source });
	return { success, text, data: { actionName: "AGENT_PLUGIN", ...data } };
}

export const agentPluginAction: Action = {
	name: "AGENT_PLUGIN",
	description:
		"Manage Agent Plugin packages. Ops: list, details, install (local dir), uninstall, reload. No remote URLs.",
	descriptionCompressed:
		"Agent Plugins: list, details, install, uninstall, reload.",
	contexts: ["automation", "settings", "connectors"],
	contextGate: { anyOf: ["automation", "settings", "connectors"] },
	similes: ["AGENT_PLUGINS", "LOAD_AGENT_PLUGIN", "INSTALL_AGENT_PLUGIN"],
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "action",
			description:
				"Operation: list, details, install, uninstall, reload. Infer if omitted.",
			required: false,
			schema: { type: "string", enum: [...ALL_OPS] },
		},
		{
			name: "name",
			description: "Plugin name for details or uninstall.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "path",
			description: "Local directory path for action=install. URLs are rejected.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "force",
			description: "For action=install: replace an existing installed plugin.",
			required: false,
			schema: { type: "boolean" },
		},
	],
	validate: async (runtime: IAgentRuntime) => {
		return Boolean(getService(runtime));
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const service = getService(runtime);
		if (!service) {
			return reply(
				callback,
				message,
				"AgentPluginsService is not available.",
				false,
				{ error: "NO_SERVICE" },
			);
		}

		const op = selectOp(message, options);
		if (!op) {
			const ops = ALL_OPS.join(", ");
			return reply(
				callback,
				message,
				`AGENT_PLUGIN could not determine the operation. Specify one of: ${ops}.`,
				false,
				{ error: "MISSING", availableOps: ops },
			);
		}

		const opts = readOptions(options);
		const text = unwrapUserMessageText(message);

		try {
			if (op === "list") {
				const plugins = service.list();
				const lines =
					plugins.length === 0
						? "No Agent Plugin packages loaded."
						: plugins.map((plugin) => `- ${summarize(plugin)}`).join("\n");
				return reply(callback, message, lines, true, {
					op,
					count: plugins.length,
					plugins: plugins.map((plugin) => ({
						name: plugin.manifest.name,
						version: plugin.manifest.version,
						skillCount: plugin.skills.length,
						mcpServerCount: plugin.mcp.servers.length,
						warnings: plugin.warnings,
					})),
				});
			}

			if (op === "reload") {
				await service.reload();
				const plugins = service.list();
				return reply(
					callback,
					message,
					`Reloaded Agent Plugins (${plugins.length} loaded).`,
					true,
					{ op, count: plugins.length },
				);
			}

			if (op === "details") {
				const name =
					typeof opts.name === "string"
						? opts.name
						: extractName(text) ?? undefined;
				if (!name) {
					return reply(
						callback,
						message,
						"Provide a plugin name for details.",
						false,
						{ op, error: "MISSING_NAME" },
					);
				}
				const plugin = service.get(name);
				if (!plugin) {
					return reply(
						callback,
						message,
						`Plugin "${name}" is not loaded.`,
						false,
						{ op, error: "NOT_FOUND", name },
					);
				}
				const body = [
					`${plugin.manifest.name}${plugin.manifest.version ? `@${plugin.manifest.version}` : ""}`,
					plugin.manifest.description ?? "",
					`root: ${plugin.root}`,
					`source: ${plugin.source}`,
					`skills: ${plugin.skills.map((s) => s.directoryName).join(", ") || "(none)"}`,
					`mcp servers: ${plugin.mcp.servers.map((s) => s.name).join(", ") || "(none)"}`,
					plugin.mcp.invalidServers.length
						? `invalid mcp: ${plugin.mcp.invalidServers.map((s) => `${s.name} (${s.reason})`).join("; ")}`
						: "",
					plugin.warnings.length
						? `warnings: ${plugin.warnings.join("; ")}`
						: "",
				]
					.filter(Boolean)
					.join("\n");
				return reply(callback, message, body, true, {
					op,
					plugin: {
						name: plugin.manifest.name,
						version: plugin.manifest.version,
						root: plugin.root,
						source: plugin.source,
						skills: plugin.skills.map((s) => s.directoryName),
						mcpServers: plugin.mcp.servers.map((s) => s.name),
						warnings: plugin.warnings,
					},
				});
			}

			if (op === "install") {
				const path =
					typeof opts.path === "string"
						? opts.path
						: extractPath(text) ?? undefined;
				if (!path) {
					return reply(
						callback,
						message,
						"Provide a local directory path to install.",
						false,
						{ op, error: "MISSING_PATH" },
					);
				}
				const plugin = await service.installFromDirectory(path, {
					force: opts.force === true,
				});
				return reply(
					callback,
					message,
					`Installed ${summarize(plugin)}.`,
					true,
					{ op, name: plugin.manifest.name },
				);
			}

			if (op === "uninstall") {
				const name =
					typeof opts.name === "string"
						? opts.name
						: extractName(text) ?? undefined;
				if (!name) {
					return reply(
						callback,
						message,
						"Provide a plugin name to uninstall.",
						false,
						{ op, error: "MISSING_NAME" },
					);
				}
				await service.uninstall(name);
				return reply(callback, message, `Uninstalled "${name}".`, true, {
					op,
					name,
				});
			}
		} catch (error) {
			const messageText =
				error instanceof Error ? error.message : String(error);
			return reply(callback, message, messageText, false, {
				op,
				error: "FAILED",
			});
		}

		return reply(callback, message, "Unhandled AGENT_PLUGIN operation.", false, {
			op,
			error: "UNHANDLED",
		});
	},
	examples: [
		[
			{ name: "{{user1}}", content: { text: "List agent plugins" } },
			{
				name: "{{agentName}}",
				content: { text: "Listing loaded Agent Plugins.", actions: ["AGENT_PLUGIN"] },
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Install the agent plugin from ./vendor/summarize" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Installing that Agent Plugin from a local directory.",
					actions: ["AGENT_PLUGIN"],
				},
			},
		],
	],
};

function extractName(text: string): string | null {
	const quoted = text.match(/["'`]([a-z0-9][a-z0-9.-]{0,63})["'`]/i);
	if (quoted?.[1]) return quoted[1].toLowerCase();
	const named = text.match(
		/\b(?:named|called|plugin)\s+([a-z0-9][a-z0-9.-]{0,63})/i,
	);
	return named?.[1]?.toLowerCase() ?? null;
}

function extractPath(text: string): string | null {
	const quoted = text.match(/["'`]([^"'`]+)["'`]/);
	if (quoted?.[1]) return quoted[1];
	const from = text.match(/\bfrom\s+(\.[^\s]+|\/[^\s]+)/i);
	return from?.[1] ?? null;
}
