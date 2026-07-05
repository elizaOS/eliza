/**
 * @module features/plugin-manager/actions/plugin
 *
 * Unified MANAGE_PLUGINS action with subactions (`install`, `eject`,
 * `sync`, `reinject`, `list`, `list_ejected`, `search`, `details`,
 * `status`, `enable`, `disable`, `core_status`, `create`).
 *
 * Validate gates on owner role + structured/context selection + a lookup
 * against any pending PLUGIN_CREATE intent task in the same room (so the
 * multi-turn choice reply still resolves).
 *
 * Handler is pure dispatch — sub-handlers live under ./plugin-handlers/.
 * Subaction routing goes through the shared `resolveActionArgs` substrate:
 * structured planner/programmatic `action` enum first, then a single LLM
 * extraction pass over the registered subactions for free-form requests.
 */

import path from "node:path";
import {
	resolveActionArgs,
	type SubactionsMap,
} from "../../../actions/resolve-action-args.ts";
import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionParameters,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
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
import {
	runDisablePlugin,
	runEnablePlugin,
	runPluginDetails,
	runPluginStatus,
} from "./plugin-handlers/runtime-state.ts";
import { runSearch } from "./plugin-handlers/search.ts";
import { runSync } from "./plugin-handlers/sync.ts";

export type PluginSubaction =
	| "install"
	| "eject"
	| "sync"
	| "reinject"
	| "list"
	| "list_ejected"
	| "search"
	| "details"
	| "status"
	| "enable"
	| "disable"
	| "core_status"
	| "create";

const SUBACTIONS: readonly PluginSubaction[] = [
	"install",
	"eject",
	"sync",
	"reinject",
	"list",
	"list_ejected",
	"search",
	"details",
	"status",
	"enable",
	"disable",
	"core_status",
	"create",
] as const;

interface PluginActionParams {
	name?: string;
	source?: "npm" | "git";
	url?: string;
	version?: string;
	query?: string;
	intent?: string;
}

/**
 * Subaction contract surfaced to `resolveActionArgs`. Required keys gate
 * extraction; the resolver picks the subaction from the structured `action`
 * enum (planner) or a single LLM pass, then we fill machine-parsed plugin
 * identifiers / queries below before dispatch.
 */
const PLUGIN_SUBACTIONS: SubactionsMap<PluginSubaction> = {
	install: {
		description: "Install a plugin from the registry by canonical name.",
		descriptionCompressed: "install plugin from registry by name",
		required: ["name"],
		optional: ["source", "url", "version"],
	},
	eject: {
		description: "Clone a registry plugin into the local plugins directory.",
		descriptionCompressed: "eject (clone) registry plugin locally",
		required: ["name"],
	},
	sync: {
		description: "Pull upstream changes into an ejected (local) plugin.",
		descriptionCompressed: "sync upstream into ejected plugin",
		required: ["name"],
	},
	reinject: {
		description: "Remove the local copy of an ejected plugin (re-inject).",
		descriptionCompressed: "reinject (remove local copy of) ejected plugin",
		required: ["name"],
	},
	list: {
		description: "List the loaded / installed plugins.",
		descriptionCompressed: "list loaded/installed plugins",
		required: [],
	},
	list_ejected: {
		description: "List the ejected (locally cloned) plugins.",
		descriptionCompressed: "list ejected plugins",
		required: [],
	},
	search: {
		description: "Search the plugin registry for a free-form capability.",
		descriptionCompressed: "search registry for plugins matching query",
		required: ["query"],
	},
	details: {
		description: "Show registry / runtime details for one plugin.",
		descriptionCompressed: "show details for one plugin",
		required: ["name"],
	},
	status: {
		description:
			"Report plugin runtime state (all plugins, or one when a name is given).",
		descriptionCompressed: "report plugin runtime status",
		required: [],
		optional: ["name"],
	},
	enable: {
		description: "Load (enable) a runtime-registered plugin.",
		descriptionCompressed: "enable runtime plugin by name",
		required: ["name"],
	},
	disable: {
		description: "Unload (disable) a runtime-registered plugin.",
		descriptionCompressed: "disable runtime plugin by name",
		required: ["name"],
	},
	core_status: {
		description: "Report the @elizaos/core ejection state.",
		descriptionCompressed: "report @elizaos/core ejection status",
		required: [],
	},
	create: {
		description:
			"Run the multi-turn create-or-edit flow that scaffolds a new plugin or edits an existing one.",
		descriptionCompressed: "create/edit a plugin via the scaffold flow",
		required: [],
		optional: ["intent"],
	},
};

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
		process.env.ELIZA_REPO_ROOT?.trim() ||
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

/**
 * Normalize a structured subaction value supplied by the planner / a
 * programmatic caller (the `action` / `subaction` / `mode` enum, including
 * legacy aliases). This matches the model's structured English-enum output,
 * not the user's free-form text.
 */
function normalizeSubaction(value: string): PluginSubaction | null {
	const normalized = value.trim().toLowerCase().replace(/-/g, "_");
	switch (normalized) {
		case "installed":
		case "loaded":
			return "list";
		case "list_ejected_plugins":
		case "ejected":
			return "list_ejected";
		case "search_plugins":
		case "search_plugin":
			return "search";
		case "get_plugin_details":
		case "plugin_details":
		case "detail":
			return "details";
		case "plugin_status":
			return "status";
		case "core_status":
		case "core":
			return "core_status";
		case "on":
			return "enable";
		case "off":
			return "disable";
		default:
			return (SUBACTIONS as readonly string[]).includes(normalized)
				? (normalized as PluginSubaction)
				: null;
	}
}

/**
 * Read an explicit structured subaction from the call options. Covers the
 * planner-supplied `action` enum, the legacy `mode` alias, and direct
 * programmatic callers (top-level or nested under `parameters`). Returns
 * `null` when the caller supplied no structured subaction — natural-language
 * routing then falls through to `resolveActionArgs`.
 */
function readExplicitSubaction(
	options: ActionOptions | undefined,
): PluginSubaction | null {
	const explicit =
		readStringOption(options, "action") ??
		readStringOption(options, "subaction") ??
		readStringOption(options, "mode");
	return explicit ? normalizeSubaction(explicit) : null;
}

function readSourceOption(
	options: ActionOptions | undefined,
): "npm" | "git" | undefined {
	const source = readStringOption(options, "source");
	if (source === "npm" || source === "git") return source;
	return undefined;
}

/**
 * Strip a trailing run of any of `chars` in a single linear pass. Used instead
 * of `/[chars]+$/` because that anchored-quantifier regex is O(n²) on the
 * free-form message text (the engine retries the run from every offset when the
 * final character is not in the set) — a ReDoS vector on attacker-supplied text.
 */
function stripTrailingChars(value: string, chars: string): string {
	let end = value.length;
	while (end > 0 && chars.includes(value[end - 1] as string)) end--;
	return value.slice(0, end);
}

/**
 * Machine extractor: pull a plugin package identifier (`@scope/plugin-x`,
 * `plugin-x`, or a bare name after an operation verb) out of free-form text.
 * Operates on plugin-identifier token shapes, not behavior-deciding NL.
 */
export function extractNameFromText(text: string): string | undefined {
	const scoped = text.match(/@[\w-]+\/(plugin-[\w.-]+)/);
	if (scoped) return scoped[0];
	const bare = text.match(/\b(plugin-[\w.-]+)\b/);
	if (bare) return bare[1];
	const short = text.match(
		/\b(?:install|eject|sync|reinject|enable|disable|activate|deactivate|turn\s+on|turn\s+off|load|unload|status|details?|info|describe)\s+(?:the\s+)?(?:plugin\s+)?([@\w][\w./-]*)\b/i,
	);
	const trimmedShort = short?.[1]?.trim();
	const candidate =
		trimmedShort === undefined
			? undefined
			: stripTrailingChars(trimmedShort, "?.!,");
	if (!candidate) return undefined;
	const lower = candidate.toLowerCase();
	if (
		[
			"plugin",
			"plugins",
			"core",
			"status",
			"ejected",
			"installed",
			"enabled",
			"disabled",
			"details",
			"info",
		].includes(lower)
	) {
		return undefined;
	}
	if (candidate.startsWith("@") || candidate.includes("/")) return candidate;
	return candidate.startsWith("plugin-") ? candidate : `plugin-${candidate}`;
}

function normalizePluginNameInput(
	name: string | undefined,
): string | undefined {
	if (!name) return undefined;
	if (
		name.startsWith("@") ||
		name.includes("/") ||
		name.startsWith("plugin-")
	) {
		return name;
	}
	return `plugin-${name}`;
}

export function extractQueryFromText(text: string): string | undefined {
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
			const cleaned = stripTrailingChars(m[1].trim(), "?.!");
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

/**
 * Seed `options.parameters` with machine-parsed plugin identifiers / query /
 * source so `resolveActionArgs` can satisfy required params even when the LLM
 * extraction does not surface them verbatim. Resolver-extracted values still
 * win for any key the LLM does fill, since the seeded values are merged as
 * planner params only when present.
 */
function buildResolverOptions(
	options: Record<string, unknown> | undefined,
	text: string,
): HandlerOptions {
	const nested = readNestedParameters(options);
	const seeded: ActionParameters =
		nested && !Array.isArray(nested) ? { ...(nested as ActionParameters) } : {};

	const name = normalizePluginNameInput(
		readStringOption(options, "name") ??
			readStringOption(options, "pluginId") ??
			extractNameFromText(text),
	);
	const source = readSourceOption(options);
	const url = readStringOption(options, "url");
	const version = readStringOption(options, "version");
	const query =
		readStringOption(options, "query") ?? extractQueryFromText(text);
	const intent = readStringOption(options, "intent");

	if (name !== undefined) seeded.name = name;
	if (source !== undefined) seeded.source = source;
	if (url !== undefined) seeded.url = url;
	if (version !== undefined) seeded.version = version;
	if (query !== undefined) seeded.query = query;
	if (intent !== undefined) seeded.intent = intent;

	return { ...(options as HandlerOptions), parameters: seeded };
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

	const dispatch = async (
		runtime: IAgentRuntime,
		message: Memory,
		options: Record<string, unknown> | undefined,
		callback: HandlerCallback | undefined,
		subaction: PluginSubaction,
		params: PluginActionParams,
	): Promise<ActionResult> => {
		logger.info(`[plugin-manager] MANAGE_PLUGINS mode=${subaction}`);
		const text = message.content.text ?? "";
		const name = params.name;

		switch (subaction) {
			case "install":
				return runInstall({
					runtime,
					name: name ?? "",
					source: params.source,
					callback,
				});
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
				return runSearch({
					runtime,
					query: params.query ?? text,
					callback,
				});
			case "details":
				return runPluginDetails({ runtime, name: name ?? "", callback });
			case "status":
				return runPluginStatus({ runtime, name, callback });
			case "enable":
				return runEnablePlugin({ runtime, name: name ?? "", callback });
			case "disable":
				return runDisablePlugin({ runtime, name: name ?? "", callback });
			case "core_status":
				return runCoreStatus({ runtime, callback });
			case "create":
				return runCreate({
					runtime,
					message,
					options,
					callback,
					intent: params.intent ?? readStringOption(options, "intent"),
					choice: readStringOption(options, "choice"),
					editTarget: readStringOption(options, "editTarget"),
					repoRoot,
				});
		}
	};

	return {
		name: "MANAGE_PLUGINS",
		contexts: ["admin", "settings", "connectors"],
		roleGate: { minRole: "OWNER" },
		suppressPostActionContinuation: true,
		similes: [
			"PLUGIN",
			"plugin control",
			"plugin manager",
			"manage installed plugins",
			"manage ejected plugins",
		],

		description:
			"Plugin control. action=install installs from registry; eject clones a registry plugin locally; sync pulls upstream into an ejected plugin; reinject removes the local copy; list shows loaded/installed; list_ejected shows ejected; search queries the registry; details shows registry/runtime details; status reports plugin state; enable/disable load or unload runtime-registered plugins; core_status reports @elizaos/core ejection state; create runs the multi-turn create-or-edit flow that scaffolds from the min-plugin template and dispatches a coding agent with AppVerificationService validator.",

		parameters: [
			{
				name: "action",
				description:
					"Action: install | eject | sync | reinject | list | list_ejected | search | details | status | enable | disable | core_status | create.",
				required: true,
				schema: { type: "string", enum: [...SUBACTIONS] },
			},
			{
				name: "mode",
				description: "Legacy alias for action. Prefer action in new calls.",
				required: false,
				schema: { type: "string", enum: [...SUBACTIONS] },
			},
			{
				name: "name",
				description:
					"Plugin name (e.g. @elizaos/plugin-discord, plugin-discord, or discord). Required for install / eject / sync / reinject / details / enable / disable. Optional for status.",
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
			state?: State,
			options?: ActionOptions,
		): Promise<boolean> => {
			if (!(await canManagePlugins(runtime, message))) return false;
			const text = message.content.text ?? "";
			const hasStructuredMode = Boolean(
				readStringOption(options, "action") ||
					readStringOption(options, "subaction") ||
					readStringOption(options, "mode"),
			);

			let hasPendingCreateChoice = false;
			if (isPluginCreateChoiceReply(text)) {
				const roomId =
					typeof message.roomId === "string" ? message.roomId : runtime.agentId;
				hasPendingCreateChoice = await hasPendingPluginCreateIntent(
					runtime,
					roomId,
				);
			}

			return (
				hasStructuredMode ||
				hasPendingCreateChoice ||
				hasActionContext(message, state, {
					contexts: ["admin", "settings", "connectors"],
				})
			);
		},

		handler: async (
			runtime: IAgentRuntime,
			message: Memory,
			state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			if (!(await canManagePlugins(runtime, message))) {
				const text = "Permission denied: only the owner may manage plugins.";
				await callback?.({ text });
				return { success: false, text };
			}

			const text = message.content.text ?? "";

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

			// Structured planner/programmatic subaction (incl. legacy `mode`
			// alias + normalization aliases) routes directly; machine-parsed
			// params are filled below. This is the planner-trust fast path.
			const explicit = readExplicitSubaction(options);
			const resolverOptions = buildResolverOptions(options, text);
			if (explicit) {
				const seededParams = (resolverOptions.parameters ??
					{}) as PluginActionParams;
				return dispatch(
					runtime,
					message,
					options,
					callback,
					explicit,
					seededParams,
				);
			}

			const resolved = await resolveActionArgs<
				PluginSubaction,
				PluginActionParams
			>({
				runtime,
				message,
				state,
				options: resolverOptions,
				actionName: "MANAGE_PLUGINS",
				subactions: PLUGIN_SUBACTIONS,
			});

			if (!resolved.ok) {
				const reply =
					'Tell me which plugin operation to run. Try: "install @elizaos/plugin-discord", "list ejected plugins", "search for plugins for blockchain", "create a new plugin for X".';
				await callback?.({ text: reply });
				return {
					success: false,
					text: reply,
					data: { action: "clarify", missing: resolved.missing },
				};
			}

			return dispatch(
				runtime,
				message,
				options,
				callback,
				resolved.subaction,
				resolved.params,
			);
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "install @elizaos/plugin-discord" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Installed @elizaos/plugin-discord@2.0.0 at /…/plugins/installed/@elizaos_plugin-discord\nRestart required to activate.",
						action: "MANAGE_PLUGINS",
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
						action: "MANAGE_PLUGINS",
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
						action: "MANAGE_PLUGINS",
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
						action: "MANAGE_PLUGINS",
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
						action: "MANAGE_PLUGINS",
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
						action: "MANAGE_PLUGINS",
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
						text: 'Found 3 plugin(s) matching "handle blockchain":\n\n1. @elizaos/plugin-wallet (match: 90%)\n   …',
						action: "MANAGE_PLUGINS",
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
						action: "MANAGE_PLUGINS",
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
						action: "MANAGE_PLUGINS",
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
						text: "Spawned coding agent. I'll verify when it's done. (Push Notifications Plugin at /…/eliza/plugins/plugin-push-notifications)",
						action: "MANAGE_PLUGINS",
					},
				},
			],
		],
	};
}

export const pluginAction: Action = createPluginAction();
