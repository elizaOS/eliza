/**
 * @module plugin-app-control/actions/app
 *
 * Unified APP action with actions (`launch`, `relaunch`,
 * `load_from_directory`, `list`, `create`).
 *
 * Validate gates on owner role + structured context + a lookup against
 * any pending APP_CREATE intent task in the same room (so the multi-turn
 * choice reply still resolves).
 *
 * Handler is pure dispatch — sub-handlers live in app-launch / app-relaunch
 * / app-list / app-load-from-directory / app-create.
 */

import path from "node:path";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { hasOwnerAccess as defaultOwnerAccessFn, logger } from "@elizaos/core";
import {
	type AppControlClient,
	createAppControlClient,
} from "../client/api.js";
import { readStringOption } from "../params.js";
import { hasPendingIntent, isChoiceReply, runCreate } from "./app-create.js";
import { runLaunch } from "./app-launch.js";
import { runList } from "./app-list.js";
import { runLoadFromDirectory } from "./app-load-from-directory.js";
import { runRelaunch } from "./app-relaunch.js";

export type AppMode =
	| "launch"
	| "relaunch"
	| "load_from_directory"
	| "list"
	| "create";

const MODES: readonly AppMode[] = [
	"launch",
	"relaunch",
	"load_from_directory",
	"list",
	"create",
] as const;

const LAUNCH_VERBS = /\b(launch|open|start|run|fire up|boot)\b/i;
const RELAUNCH_VERBS = /\b(relaunch|restart|reboot|reload)\b/i;
const STOP_VERBS = /\b(close|stop|exit|quit|kill|shut\s*down|terminate)\b/i;
const LIST_VERBS =
	/\b(list|show|what['’]s open|running|whats? open|whats? running)\b/i;
const CREATE_VERBS =
	/\b(create|build|make|new|scaffold|generate|spin up)\b.*?\b(app|application|game|tool|widget|dashboard)\b/i;
const PLUGIN_ONLY = /\bplugin\b/i;
const APP_NOUN = /\b(app|apps|application|applications|mini)\b/i;
const LOAD_FROM_DIR =
	/\b(load|register|import|scan)\b.*\b(directory|folder|dir|path)\b/i;

type OwnerAccessFn = (
	runtime: IAgentRuntime,
	message: Memory,
) => Promise<boolean>;

interface AppActionDeps {
	client?: AppControlClient;
	hasOwnerAccess?: OwnerAccessFn;
	repoRoot?: string;
}

function defaultRepoRoot(): string {
	const fromEnv =
		process.env.ELIZA_REPO_ROOT?.trim() ||
		process.env.ELIZA_WORKSPACE_DIR?.trim() ||
		process.env.ELIZA_WORKSPACE_DIR?.trim();
	if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
	return process.cwd();
}

function inferMode(
	text: string,
	options?: Record<string, unknown>,
): AppMode | null {
	const explicit =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	if (explicit && (MODES as readonly string[]).includes(explicit)) {
		return explicit as AppMode;
	}

	const trimmed = text.trim();
	if (!trimmed) return null;

	if (LOAD_FROM_DIR.test(trimmed)) return "load_from_directory";

	if (CREATE_VERBS.test(trimmed) && !PLUGIN_ONLY.test(trimmed)) {
		return "create";
	}

	// "what apps are open" / "list running"
	if (LIST_VERBS.test(trimmed) && APP_NOUN.test(trimmed)) return "list";
	if (RELAUNCH_VERBS.test(trimmed) && APP_NOUN.test(trimmed)) return "relaunch";

	if (STOP_VERBS.test(trimmed) && APP_NOUN.test(trimmed)) {
		// Stop folds into relaunch only when paired with a launch verb;
		// otherwise it's not an APP-action concern (no close mode).
		if (LAUNCH_VERBS.test(trimmed)) return "relaunch";
		// Fall through — stand-alone "close X app" still routes to relaunch
		// with verify off, treating it as a stop+relaunch is wrong; we
		// instead route to list so the user can see candidates without
		// silently restarting.
		return "list";
	}

	if (LAUNCH_VERBS.test(trimmed) && APP_NOUN.test(trimmed)) return "launch";

	return null;
}

// `defaultOwnerAccessFn` is the real `hasOwnerAccess` from ./security.js
// (imported above), which uses `checkSenderRole` from `@elizaos/core`.
// Defined in ./security so this plugin doesn't need an `@elizaos/agent` dep.

function hasAccessContext(runtime: IAgentRuntime, message: Memory): boolean {
	return (
		typeof runtime.agentId === "string" &&
		runtime.agentId.length > 0 &&
		typeof message.entityId === "string" &&
		message.entityId.length > 0
	);
}

export function createAppAction(deps: AppActionDeps = {}): Action {
	const clientFactory = () => deps.client ?? createAppControlClient();
	const ownerCheck = deps.hasOwnerAccess ?? defaultOwnerAccessFn;
	const repoRoot = deps.repoRoot ?? defaultRepoRoot();

	const canManageApps = async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (!hasAccessContext(runtime, message)) return false;
		return ownerCheck(runtime, message);
	};

	return {
		name: "APP",
		contexts: ["automation", "settings", "code"],
		contextGate: { anyOf: ["automation", "settings", "code"] },
		roleGate: { minRole: "USER" },
		similes: ["APP_CONTROL", "MANAGE_APPS"],
		description:
			"Unified app control. action=launch starts a registered app; action=relaunch stops then launches (optionally with verify); action=list shows installed + running apps; action=load_from_directory registers apps from an absolute folder; action=create runs the multi-turn create-or-edit flow that searches existing apps, asks new/edit/cancel, scaffolds from the min-app template, and dispatches a coding agent with AppVerificationService validator.",
		descriptionCompressed:
			"Manage apps: launch/relaunch/list/load folder/create; create scaffolds min app, runs coding agent, verifies result.",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "action",
				description:
					"Operation: launch | relaunch | load_from_directory | list | create.",
				required: true,
				schema: {
					type: "string",
					enum: [...MODES],
				},
			},
			{
				name: "mode",
				description: "Legacy alias for action.",
				required: false,
				schema: {
					type: "string",
					enum: [...MODES],
				},
			},
			{
				name: "app",
				description:
					"App name, slug, or display name (launch / relaunch / create-edit).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "name",
				description: "Alias for `app`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "runId",
				description:
					"Specific run id to stop before relaunching (relaunch mode).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "verify",
				description:
					"When true, runs AppVerificationService (fast profile) after relaunch.",
				required: false,
				schema: { type: "boolean", default: false },
			},
			{
				name: "workdir",
				description:
					"Absolute workdir for verify (relaunch) or for explicit edit (create).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "directory",
				description: "Absolute directory to scan (load_from_directory mode).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "intent",
				description:
					"Free-form description of the app to build (create mode). Defaults to the user message text.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "editTarget",
				description:
					"Skip the picker and edit this installed app directly (create mode).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "choice",
				description:
					"Override choice reply (`new` | `edit-N` | `cancel`) for create mode follow-up turns.",
				required: false,
				schema: { type: "string" },
			},
		],

		validate: async (
			runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			if (!(await canManageApps(runtime, message))) return false;
			const text = message.content?.text ?? "";

			// Multi-turn follow-up: short reply matches a pending intent task.
			if (isChoiceReply(text)) {
				const roomId =
					typeof message.roomId === "string" ? message.roomId : runtime.agentId;
				if (await hasPendingIntent(runtime, roomId)) return true;
			}

			return true;
		},

		handler: async (
			runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			if (!(await canManageApps(runtime, message))) {
				const text = "Permission denied: only the owner may manage apps.";
				await callback?.({ text });
				return { success: false, text };
			}

			const client = clientFactory();
			const text = message.content?.text ?? "";

			// Follow-up choice reply always routes to create.
			if (isChoiceReply(text)) {
				const roomId =
					typeof message.roomId === "string" ? message.roomId : runtime.agentId;
				if (await hasPendingIntent(runtime, roomId)) {
					return runCreate({
						runtime,
						client,
						message,
						options,
						callback,
						repoRoot,
					});
				}
			}

			const mode = inferMode(text, options);
			if (!mode) {
				const reply =
					'Tell me which app to control. Try: "launch shopify", "list running apps", "create a new note-taking app".';
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}

			logger.info(`[plugin-app-control] APP mode=${mode}`);

			switch (mode) {
				case "launch":
					return runLaunch({ client, message, options, callback });
				case "relaunch":
					return runRelaunch({
						runtime,
						client,
						message,
						options,
						callback,
					});
				case "list":
					return runList({ client, callback });
				case "load_from_directory":
					return runLoadFromDirectory({
						runtime,
						message,
						options,
						callback,
						repoRoot,
					});
				case "create":
					return runCreate({
						runtime,
						client,
						message,
						options,
						callback,
						repoRoot,
					});
			}
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "launch shopify" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Launched Shopify. Run ID: run_abc123.",
						action: "APP",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "what apps are open?" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Installed apps (2):\n  - Shopify (shopify) — running x1 [run_abc]\n  - Companion (companion)",
						action: "APP",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "relaunch shopify and verify" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Relaunched Shopify. New run ID: run_xyz.\nVerify (fast): pass",
						action: "APP",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "build me a small note-taking app" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "[CHOICE:app-create id=app-create-…]\nnew = Create a new app\nedit-1 = Edit existing: Notes (notes)\ncancel = Cancel\n[/CHOICE]",
						action: "APP",
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
						text: "Scaffolded Note Taker at /…/eliza/plugins/app-note-taker and spawned a coding agent in the background. I'll verify when it's done.",
						action: "APP",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: {
						text: "load apps from /Users/me/dev/my-apps directory",
					},
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Registered 2 apps from /Users/me/dev/my-apps:\n  - My App (@me/app-mine)\n  - Other App (@me/app-other)",
						action: "APP",
					},
				},
			],
		],
	};
}

export const appAction: Action = createAppAction();
