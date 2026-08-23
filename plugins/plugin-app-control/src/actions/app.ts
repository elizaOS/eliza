/**
 * Dispatches the unified APP action across launch, relaunch, stop,
 * load-from-directory, list, and create operations.
 *
 * Validate gates on owner role + structured context + a lookup against
 * any pending APP_CREATE intent task in the same room (so the multi-turn
 * choice reply still resolves).
 *
 * Sub-handlers own each operation so this module remains the planner contract
 * and authorization boundary.
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
import {
	normalizeActionOptions,
	readStringOption,
	userRequestMessageText,
} from "../params.js";
import { hasPendingIntent, isChoiceReply, runCreate } from "./app-create.js";
import { runLaunch } from "./app-launch.js";
import { runList } from "./app-list.js";
import { runLoadFromDirectory } from "./app-load-from-directory.js";
import { runRelaunch } from "./app-relaunch.js";
import { runStop } from "./app-stop.js";
import { createViewsClient } from "./views-client.js";
import { requestWorkspaceDismissal } from "./workspace-dismiss.js";

export type AppMode =
	| "launch"
	| "relaunch"
	| "stop"
	| "load_from_directory"
	| "list"
	| "create";

const MODES: readonly AppMode[] = [
	"launch",
	"relaunch",
	"stop",
	"load_from_directory",
	"list",
	"create",
] as const;

const LAUNCH_VERBS = /\b(launch|open|start|run|fire up|boot)\b/i;
const RELAUNCH_VERBS = /\b(relaunch|restart|reboot|reload)\b/i;
const STOP_VERBS = /\b(close|stop|exit|quit|kill|shut\s*down|terminate)\b/i;
const LIST_VERBS =
	/\b(list|show|what['’]s open|running|whats? open|whats? running)\b/i;
// Deletion verbs get a designed refusal, not a mode: APP deliberately has no
// delete/uninstall — per-app deletion lives in VIEWS action=delete behind
// confirmation + protected-app checks. Checked only after inferMode returns
// null so stop phrasings ("kill/close the app") keep routing to stop.
const DELETE_VERBS = /\b(delete|uninstall|remove|wipe|erase|purge)\b/i;
const CREATE_VERBS =
	/\b(create|build|make|new|scaffold|generate|spin up)\b.*?\b(app|application|game|tool|widget|dashboard)\b/i;
const PLUGIN_ONLY = /\bplugin\b/i;
const APP_NOUN = /\b(app|apps|application|applications|mini)\b/i;
const LOAD_FROM_DIR =
	/\b(load|register|import|scan)\b.*\b(directory|folder|dir|path)\b/i;

const ELIZA_WORKSPACE_TARGET = /^(?:eliza(?:os)?(?:\s+app)?|workspace)$/i;

function isElizaWorkspaceDismissRequest(
	text: string,
	options?: Record<string, unknown>,
): boolean {
	const explicitTarget =
		readStringOption(options, "app") ??
		readStringOption(options, "name") ??
		readStringOption(options, "target");
	if (explicitTarget && ELIZA_WORKSPACE_TARGET.test(explicitTarget.trim())) {
		return true;
	}
	return /\b(?:close|hide|quit|exit)\s+(?:the\s+)?(?:eliza(?:os)?(?:\s+app)?|workspace)\b/i.test(
		text,
	);
}

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
		if (LAUNCH_VERBS.test(trimmed)) return "relaunch";
		return "stop";
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
	const getRepoRoot = () => deps.repoRoot ?? defaultRepoRoot();

	const canManageApps = async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (!hasAccessContext(runtime, message)) return false;
		return ownerCheck(runtime, message);
	};

	return {
		name: "APP",
		// "general" is included because unambiguous app asks ("show me the
		// apps", "launch shopify") are routinely routed to the general context
		// by Stage 1; without it the APP action never reaches the planner
		// surface for exactly the requests it exists to serve (#9950).
		contexts: ["automation", "settings", "code", "general"],
		contextGate: { anyOf: ["automation", "settings", "code", "general"] },
		roleGate: { minRole: "OWNER" },
		// Retrieval + Stage-1 candidate attractors. Deliberately excludes
		// SHOW_APPS / OPEN_APPS / OPEN_APP / SHOW_APP — those are claimed by
		// VIEWS (apps-page navigation) and by the core candidate alias map;
		// APP keeps the list/launch/install vocabulary for the applications
		// themselves.
		similes: [
			"APP_CONTROL",
			"MANAGE_APPS",
			"LIST_APPS",
			"LIST_INSTALLED_APPS",
			"GET_INSTALLED_APPS",
			"INSTALLED_APPS",
			"LIST_RUNNING_APPS",
			"RUNNING_APPS",
			"APP_LIST",
			"LAUNCH_APP",
			"START_APP",
			"RUN_APP",
			"RESTART_APP",
			"RELAUNCH_APP",
			"STOP_APP",
			"CLOSE_APP",
			"CREATE_APP",
			"BUILD_APP",
			"NEW_APP",
			"BUILD_WEB_APP",
			"HOST_WEB_APP",
			"MAKE_WEBSITE",
			"PUBLISH_WEB_PAGE",
			"CREATE_HTML_APP",
		],
		tags: [
			"app",
			"apps",
			"applications",
			"launcher",
			"installed",
			"running",
			"launch",
			"relaunch",
			"stop",
			"scaffold",
		],
		description:
			"Unified control of apps installed on this device. action=launch starts a registered app; action=relaunch stops then launches (optionally with verify); action=stop stops a running app without uninstalling it; action=list shows installed + running apps; action=load_from_directory registers apps from an absolute folder; action=create BUILDS AND HOSTS a new web app / web page / website: the multi-turn create-or-edit flow searches existing apps, asks new/edit/cancel, scaffolds from the min-app template, dispatches a coding agent with AppVerificationService validator, and (when a publish target is configured) publishes the verified build and returns a live URL the user can open.",
		descriptionCompressed:
			"apps launch|relaunch|stop|list|load_folder|create; create builds a web app/page/site and publishes a live link when a publish target is configured",
		routingHint:
			"Installed applications themselves -> APP. 'Show me the apps', 'list my apps', 'what apps are installed/running', launching, stopping, or restarting a registered app, registering apps from a folder, or building a new app is APP (action=list|launch|stop|relaunch|load_from_directory|create) — answer installed-app-list requests with APP action=list, never with a UI view list. Building/hosting/publishing a NEW web app, web page, or interactive HTML the user wants a live link for ('teach me with an interactive page', 'host it and give me the link') is APP action=create — it builds and, when a publish target is configured, publishes with a live link; do not route that to a generic coding task or a Cloud deploy. VIEWS covers UI views/panels and the apps *page*; APP covers the applications. The user's own Eliza Cloud apps ('my cloud apps', hosted apps/sites created or deployed on Eliza Cloud) are LIST_CLOUD_APPS, NOT this action.",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "action",
				description:
					"Operation: launch | relaunch | stop | load_from_directory | list | create.",
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
					"App name, slug, or display name (launch / relaunch / stop / create-edit).",
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
					"Specific run id to stop (stop mode) or stop before relaunching (relaunch mode).",
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
			// Live planners naturally decorate create calls with a title and/or a
			// description alongside (or instead of) `intent`; argument validation
			// is strict, so leaving these undeclared hard-fails the whole call
			// (#16939). Declared here and folded into the build intent.
			{
				name: "title",
				description:
					"Display title for the app to build (create mode); folded into the build intent.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "description",
				description:
					"Longer description of the app to build (create mode); folded into the build intent when `intent` is absent.",
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
			const text = userRequestMessageText(message);

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
			const actionOptions = normalizeActionOptions(options);
			if (!(await canManageApps(runtime, message))) {
				const text = "Sorry — only my owner can manage apps.";
				await callback?.({ text });
				return { success: false, text };
			}

			const client = clientFactory();
			const text = userRequestMessageText(message);

			// "Eliza" names this native shell, not a registered mini-app. Never
			// fuzzy-match it to another app (for example Cloud Apps), and never
			// terminate the resident pill/tray process. Dismiss only the reusable
			// Workspace window through the same targeted view delivery path.
			if (isElizaWorkspaceDismissRequest(text, actionOptions)) {
				const currentView = await createViewsClient()
					.getCurrentView()
					.catch(() => null);
				const metadata = (
					message.content as { metadata?: Record<string, unknown> } | undefined
				)?.metadata;
				const rawClientId = metadata?.viewClientId;
				const clientId =
					typeof rawClientId === "string" &&
					/^[A-Za-z0-9._-]{1,128}$/.test(rawClientId)
						? rawClientId
						: undefined;
				const result = await requestWorkspaceDismissal({
					clientId,
					currentViewExists: Boolean(currentView?.viewId),
				});
				await callback?.({ text: result.text });
				return {
					success: result.ok,
					text: result.text,
					values: { mode: "stop", stopScope: "workspace" },
					data: {
						actionName: "APP",
						target: "workspace",
						closed: result.closed,
					},
				};
			}

			// Follow-up choice reply always routes to create.
			if (isChoiceReply(text)) {
				const roomId =
					typeof message.roomId === "string" ? message.roomId : runtime.agentId;
				if (await hasPendingIntent(runtime, roomId)) {
					return runCreate({
						runtime,
						client,
						message,
						options: actionOptions,
						callback,
						repoRoot: getRepoRoot(),
					});
				}
			}

			const mode = inferMode(text, actionOptions);
			if (!mode) {
				// A delete/uninstall ask has no APP mode by design. Answer with the
				// designed refusal (with tool-owned userFacingText, so planner-loop
				// failure authority surfaces this prose instead of the generic
				// failed-tool fallback) rather than the mode-clarify, which invites
				// the planner to improvise.
				if (DELETE_VERBS.test(text) && APP_NOUN.test(text)) {
					const bulkDelete = /\b(?:all|every)\b/i.test(text);
					return {
						success: false,
						text: "APP has no delete/uninstall mode. Per-app deletion goes through VIEWS action=delete, which asks the user to confirm and enforces protected-app checks; bulk-deleting all apps is not supported. Do not retry APP for this — state it to the user in voice.",
						userFacingText: bulkDelete
							? "I can't bulk-delete apps. App removal is one app at a time and requires confirmation through the delete flow."
							: "I can't uninstall apps through APP. App removal is handled one app at a time through the confirmed delete flow.",
						data: { actionName: "APP", error: "DELETE_UNSUPPORTED" },
					};
				}
				// Planner-facing only: the canned mode menu double-messaged next to
				// the evaluator's in-voice clarification. The evaluator owns asking
				// the user, in voice.
				const reply =
					"No app-control mode could be inferred; ask the user whether they want to launch, relaunch, list, load, or create an app.";
				return { success: false, text: reply };
			}

			logger.info(`[plugin-app-control] APP mode=${mode}`);

			switch (mode) {
				case "launch":
					return runLaunch({
						client,
						message,
						options: actionOptions,
						callback,
					});
				case "relaunch":
					return runRelaunch({
						runtime,
						client,
						message,
						options: actionOptions,
						callback,
					});
				case "stop":
					return runStop({
						client,
						message,
						options: actionOptions,
						callback,
					});
				case "list":
					return runList({ client });
				case "load_from_directory":
					return runLoadFromDirectory({
						runtime,
						message,
						options: actionOptions,
						callback,
						repoRoot: getRepoRoot(),
					});
				case "create":
					return runCreate({
						runtime,
						client,
						message,
						options: actionOptions,
						callback,
						repoRoot: getRepoRoot(),
					});
			}
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "stop the shopify app" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Shopify stopped.",
						action: "APP",
					},
				},
			],
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
						text: "Installed apps (2):\n  - Shopify (shopify) — running x1 [run_abc]\n  - Feed (feed)",
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
