/**
 * @module features/plugin-manager/actions/plugin
 *
 * Unified PLUGIN action with sub-modes (`install`, `eject`, `sync`,
 * `reinject`, `list`, `list_ejected`, `search`, `core_status`, `create`).
 *
 * Validate gates on owner role + a keyword heuristic + a lookup against
 * any pending PLUGIN_CREATE intent task in the same room (so the
 * multi-turn choice reply still resolves).
 *
 * Handler is pure dispatch — sub-handlers live under ./plugin-handlers/.
 */

import path from "node:path";
import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionResult,
	HandlerCallback,
} from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import { hasOwnerAccess as defaultOwnerAccessFn } from "../security.ts";
import { runCoreStatus } from "./plugin-handlers/core-status.ts";
import {
	hasPendingPluginCreateIntent,
	isPluginCreateChoiceReply,
	runCreate,
} from "./plugin-handlers/create.ts";
import { runEject } from "./plugin-handlers/eject.ts";
import { runInstall } from "./plugin-handlers/install.ts";
import { runList } from "./plugin-handlers/list.ts";
import { runListEjected } from "./plugin-handlers/list-ejected.ts";
import { runReinject } from "./plugin-handlers/reinject.ts";
import { runSearch } from "./plugin-handlers/search.ts";
import { runSync } from "./plugin-handlers/sync.ts";

export type PluginMode =
	| "install"
	| "eject"
	| "sync"
	| "reinject"
	| "list"
	| "list_ejected"
	| "search"
	| "core_status"
	| "create";

const MODES: readonly PluginMode[] = [
	"install",
	"eject",
	"sync",
	"reinject",
	"list",
	"list_ejected",
	"search",
	"core_status",
	"create",
] as const;

const INSTALL_VERBS = /\binstall\b/i;
const EJECT_VERBS = /\beject\b/i;
const SYNC_VERBS = /\bsync\b/i;
const REINJECT_VERBS = /\b(reinject|re-inject|unject)\b/i;
const SEARCH_VERBS = /\b(search|find|look\s+for|discover)\b/i;
const LIST_VERBS = /\b(list|show)\b/i;
const CREATE_VERBS = /\b(create|build|make|new|scaffold|generate)\b/i;
const PLUGIN_NOUN = /\bplugins?\b/i;
const EJECTED_NOUN = /\bejected\b/i;
const CORE_NOUN = /\bcore\b/i;
const STATUS_NOUN = /\bstatus\b/i;
const MANAGE_VERBS = /\b(manage|build|create|build|fix|update|edit)\b/i;

const KEYWORD_HEURISTIC =
	/\b(install|eject|sync|reinject|search|find|create|build|make|scaffold|new|list|show|manage|fix|update|edit)\b.*\bplugins?\b|\bcore\s+status\b|\bplugin\b.*\b(install|eject|sync|reinject|search|find|create|build|make|scaffold|new|list|show)\b/i;

type OwnerAccessFn = (
	runtime: IAgentRuntime,
	message: Memory,
) => Promise<boolean>;

interface PluginActionDeps {
	hasOwnerAccess?: OwnerAccessFn;
	repoRoot?: string;
}

type ActionOptions = Record<string, unknown>;

function defaultRepoRoot(): string {
	const fromEnv =
		process.env.MILADY_REPO_ROOT?.trim() ||
		process.env.MILADY_WORKSPACE_DIR?.trim() ||
		process.env.ELIZA_WORKSPACE_DIR?.trim();
	if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
	return process.cwd();
}

function readNestedParameters(
	options: ActionOptions | undefined,
): ActionOptions | undefined {
	const parameters = options?.parameters;
	if (
		typeof parameters !== "object" ||
		parameters === null ||
		Array.isArray(parameters)
	) {
		return undefined;
	}
	return parameters as ActionOptions;
}

function readOptionValue(
	options: ActionOptions | undefined,
	key: string,
): unknown {
	if (!options) return undefined;
	const direct = options[key];
	if (direct !== undefined) return direct;
	return readNestedParameters(options)?.[key];
}

function readStringOption(
	options: ActionOptions | undefined,
	key: string,
): string | undefined {
	const value = readOptionValue(options, key);
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readSourceOption(
	options: ActionOptions | undefined,
): "npm" | "git" | undefined {
	const source = readStringOption(options, "source");
	if (source === "npm" || source === "git") return source;
	return undefined;
}

function inferMode(
	text: string,
	options?: Record<string, unknown>,
): PluginMode | null {
	const explicit = readStringOption(options, "mode");
	if (explicit && (MODES as readonly string[]).includes(explicit)) {
		return explicit as PluginMode;
	}

	const trimmed = text.trim();
	if (!trimmed) return null;

	if (CORE_NOUN.test(trimmed) && STATUS_NOUN.test(trimmed)) return "core_status";

	if (LIST_VERBS.test(trimmed) && EJECTED_NOUN.test(trimmed))
		return "list_ejected";
	if (LIST_VERBS.test(trimmed) && PLUGIN_NOUN.test(trimmed)) return "list";

	if (REINJECT_VERBS.test(trimmed)) return "reinject";
	if (EJECT_VERBS.test(trimmed)) return "eject";
	if (SYNC_VERBS.test(trimmed) && PLUGIN_NOUN.test(trimmed)) return "sync";
	if (INSTALL_VERBS.test(trimmed) && PLUGIN_NOUN.test(trimmed)) return "install";
	if (SEARCH_VERBS.test(trimmed) && PLUGIN_NOUN.test(trimmed)) return "search";

	if (CREATE_VERBS.test(trimmed) && PLUGIN_NOUN.test(trimmed)) return "create";
	if (MANAGE_VERBS.test(trimmed) && PLUGIN_NOUN.test(trimmed)) return "create";

	return null;
}

function extractNameFromText(text: string): string | undefined {
	const scoped = text.match(/@[\w-]+\/(plugin-[\w.-]+)/);
	if (scoped) return scoped[0];
	const bare = text.match(/\b(plugin-[\w.-]+)\b/);
	if (bare) return bare[1];
	return undefined;
}

function extractQueryFromText(text: string): string | undefined {
	const patterns = [
		/search\s+for\s+plugins?\s+(?:that\s+)?(?:can\s+)?(.+)/i,
		/find\s+plugins?\s+(?:for|that|to)\s+(.+)/i,
		/look\s+for\s+plugins?\s+(?:that\s+)?(.+)/i,
		/discover\s+plugins?\s+(?:for|that)\s+(.+)/i,
		/plugins?\s+(?:for|that\s+can|to)\s+(.+)/i,
	];
	for (const pattern of patterns) {
		const m = text.match(pattern);
		if (m?.[1]) {
			const cleaned = m[1].trim().replace(/[?.!]+$/, "");
			if (cleaned.length > 2) return cleaned;
		}
	}
	return undefined;
}

function hasAccessContext(runtime: IAgentRuntime, message: Memory): boolean {
	return (
		typeof runtime.agentId === "string" &&
		runtime.agentId.length > 0 &&
		typeof message.entityId === "string" &&
		message.entityId.length > 0
	);
}

export function createPluginAction(deps: PluginActionDeps = {}): Action {
	const ownerCheck = deps.hasOwnerAccess ?? defaultOwnerAccessFn;
	const repoRoot = deps.repoRoot ?? defaultRepoRoot();

	const canManagePlugins = async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (!hasAccessContext(runtime, message)) return false;
		return ownerCheck(runtime, message);
	};

	return {
		name: "PLUGIN",
		similes: [
			"PLUGIN_CONTROL",
			"MANAGE_PLUGINS",
			// Legacy single-purpose action names — preserved as similes so
			// callers that still dispatch by these names resolve to PLUGIN
			// without breaking. Covers both the prior workspace plugin's
			// names and the prior built-in capability's names.
			"INSTALL_PLUGIN",
			"EJECT_PLUGIN",
			"SYNC_PLUGIN",
			"REINJECT_PLUGIN",
			"LIST_EJECTED_PLUGINS",
			"SEARCH_PLUGIN",
			"SEARCH_PLUGINS",
			"CORE_STATUS",
			"GET_PLUGIN_DETAILS",
		],

		description:
			"Unified plugin control. mode=install installs from registry; mode=eject clones a registry plugin locally; mode=sync pulls upstream into an ejected plugin; mode=reinject removes the local copy; mode=list shows loaded/installed; mode=list_ejected shows ejected; mode=search queries the registry; mode=core_status reports @elizaos/core ejection state; mode=create runs the multi-turn create-or-edit flow that scaffolds from the min-plugin template and dispatches a coding agent with AppVerificationService validator.",

		parameters: [
			{
				name: "mode",
				description:
					"Sub-mode: install | eject | sync | reinject | list | list_ejected | search | core_status | create.",
				required: true,
				schema: { type: "string", enum: [...MODES] },
			},
			{
				name: "name",
				description:
					"Plugin name (e.g. @elizaos/plugin-twitter or plugin-twitter). Required for install / eject / sync / reinject.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "version",
				description: "Version spec for install (npm semver). Optional.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "source",
				description: "Install source: npm (default) or git.",
				required: false,
				schema: { type: "string", enum: ["npm", "git"] },
			},
			{
				name: "url",
				description: "Override git URL when source=git.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "query",
				description: "Free-form search query (search mode).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "intent",
				description:
					"Free-form description of the plugin to build (create mode). Defaults to user message text.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "choice",
				description:
					"Override choice reply (`new` | `edit-N` | `cancel`) for create-mode follow-up turns.",
				required: false,
				schema: { type: "string", enum: ["new", "edit", "cancel"] },
			},
			{
				name: "editTarget",
				description:
					"Skip the picker and edit this installed plugin directly (create mode).",
				required: false,
				schema: { type: "string" },
			},
		],

		validate: async (
			runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			if (!(await canManagePlugins(runtime, message))) return false;
			const text = message.content?.text ?? "";

			if (isPluginCreateChoiceReply(text)) {
				const roomId =
					typeof message.roomId === "string" ? message.roomId : runtime.agentId;
				if (await hasPendingPluginCreateIntent(runtime, roomId)) return true;
			}

			return KEYWORD_HEURISTIC.test(text);
		},

		handler: async (
			runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			if (!(await canManagePlugins(runtime, message))) {
				const text = "Permission denied: only the owner may manage plugins.";
				await callback?.({ text });
				return { success: false, text };
			}

			const text = message.content?.text ?? "";

			if (isPluginCreateChoiceReply(text)) {
				const roomId =
					typeof message.roomId === "string" ? message.roomId : runtime.agentId;
				if (await hasPendingPluginCreateIntent(runtime, roomId)) {
					return runCreate({
						runtime,
						message,
						options,
						callback,
						choice: text.trim(),
						repoRoot,
					});
				}
			}

			const mode = inferMode(text, options);
			if (!mode) {
				const reply =
					'Tell me which plugin operation to run. Try: "install @elizaos/plugin-twitter", "list ejected plugins", "search for plugins for blockchain", "create a new plugin for X".';
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}

			logger.info(`[plugin-manager] PLUGIN mode=${mode}`);

			const name = readStringOption(options, "name") ?? extractNameFromText(text);
			const source = readSourceOption(options);
			const query =
				readStringOption(options, "query") ?? extractQueryFromText(text) ?? text;

			switch (mode) {
				case "install":
					return runInstall({ runtime, name: name ?? "", source, callback });
				case "eject":
					return runEject({ runtime, name: name ?? "", callback });
				case "sync":
					return runSync({ runtime, name: name ?? "", callback });
				case "reinject":
					return runReinject({ runtime, name: name ?? "", callback });
				case "list":
					return runList({ runtime, callback });
				case "list_ejected":
					return runListEjected({ runtime, callback });
				case "search":
					return runSearch({ runtime, query, callback });
				case "core_status":
					return runCoreStatus({ runtime, callback });
				case "create":
					return runCreate({
						runtime,
						message,
						options,
						callback,
						intent: readStringOption(options, "intent"),
						choice: readStringOption(options, "choice"),
						editTarget: readStringOption(options, "editTarget"),
						repoRoot,
					});
			}
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "install @elizaos/plugin-twitter" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Installed @elizaos/plugin-twitter@2.0.0 at /…/plugins/installed/@elizaos_plugin-twitter\nRestart required to activate.",
						action: "PLUGIN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "eject @elizaos/plugin-shopify" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Ejected @elizaos/plugin-shopify to /…/plugins/ejected/@elizaos_plugin-shopify (commit 1234abcd)\nRestart required to load the local copy.",
						action: "PLUGIN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "sync plugin-shopify" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Synced @elizaos/plugin-shopify: 3 new upstream commit(s) at deadbeef\nRestart required.",
						action: "PLUGIN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "reinject plugin-shopify" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Reinjected plugin-shopify (removed /…/plugins/ejected/plugin-shopify)\nRestart required.",
						action: "PLUGIN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "list plugins" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Loaded plugins (2):\n  - plugin-manager [LOADED]\n  - @elizaos/plugin-sql [LOADED]",
						action: "PLUGIN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "list ejected plugins" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Ejected plugins (1):\n  - @elizaos/plugin-shopify (v2.0.0) at /…/plugins/ejected/@elizaos_plugin-shopify",
						action: "PLUGIN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "search for plugins that handle blockchain" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Found 3 plugin(s) matching "handle blockchain":\n\n1. @elizaos/plugin-evm (match: 90%)\n   …',
						action: "PLUGIN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "core status" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Core is using NPM package (v2.0.0-alpha.372). Not ejected.",
						action: "PLUGIN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "build me a plugin for sending push notifications" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "[CHOICE:plugin-create id=plugin-create-…]\nnew = Create new plugin\nedit-1 = Edit plugin-notifications\ncancel = Cancel\n[/CHOICE]",
						action: "PLUGIN",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "new" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Spawned coding agent. I'll verify when it's done. (Push Notifications Plugin at /…/eliza/plugins/plugin-push-notifications/typescript)",
						action: "PLUGIN",
					},
				},
			],
		],
	};
}

export const pluginAction: Action = createPluginAction();
