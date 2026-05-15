/**
 * @module plugin-app-control/actions/views
 *
 * Unified VIEWS action. Lets the Eliza agent list, open, search, and manage
 * UI views contributed by plugins via `Plugin.views`.
 *
 * Sub-modes dispatched from a single action keep the planner surface minimal
 * and the handler testable. Mirrors the APP action structure.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { type ViewsClient, createViewsClient } from "./views-client.js";
import { runViewsList } from "./views-list.js";
import { runViewsSearch } from "./views-search.js";
import { runViewsShow } from "./views-show.js";
import { readStringOption } from "../params.js";

export type ViewsMode = "list" | "show" | "open" | "search" | "manager";

const MODES: readonly ViewsMode[] = [
	"list",
	"show",
	"open",
	"search",
	"manager",
] as const;

// Intent regexes — order matters: more specific first.
const LIST_VERBS =
	/\b(list|show all|what views|all views|available views|which views)\b/i;
const WHAT_VIEWS_VERB = /what.{0,20}views?\b/i;
const SEARCH_VERBS = /\b(search|find|look for|filter)\b.*\bview/i;
const MANAGER_VERBS =
	/\b(view manager|views manager|manage views|open manager|show manager)\b/i;
const SHOW_ALL_VIEWS_MANAGER =
	/\b(show|open|bring up|pull up)\b\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?views\b/i;
const SHOW_APPS_VERBS =
	/\b(show|open|go to|navigate to)\b\s+(?:the\s+)?(?:apps?|app page|apps page)\b/i;
const CLOSE_VERBS =
	/\b(close|dismiss|hide|exit|quit)\b.{0,40}\b(view|app|panel|window)\b/i;
const SHOW_VERBS =
	/\b(show|open|navigate to|go to|switch to|launch|display|bring up|pull up)\b/i;
const VIEW_NOUN = /\bview[s]?\b/i;

interface ViewsActionDeps {
	client?: ViewsClient;
}

function inferMode(
	text: string,
	options?: Record<string, unknown>,
): ViewsMode | null {
	const explicit =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	if (explicit && (MODES as readonly string[]).includes(explicit)) {
		return explicit as ViewsMode;
	}

	const trimmed = text.trim();
	if (!trimmed) return null;

	if (MANAGER_VERBS.test(trimmed)) return "manager";
	if (SHOW_ALL_VIEWS_MANAGER.test(trimmed)) return "manager";
	if (SHOW_APPS_VERBS.test(trimmed)) return "manager";
	if (CLOSE_VERBS.test(trimmed)) return "manager";
	if (SEARCH_VERBS.test(trimmed)) return "search";
	if (WHAT_VIEWS_VERB.test(trimmed)) return "list";
	if (LIST_VERBS.test(trimmed) && VIEW_NOUN.test(trimmed)) return "list";
	if (SHOW_VERBS.test(trimmed) && VIEW_NOUN.test(trimmed)) return "show";

	return null;
}

function extractSearchQuery(
	text: string,
	options?: Record<string, unknown>,
): string {
	const explicit =
		readStringOption(options, "query") ?? readStringOption(options, "search");
	if (explicit) return explicit;

	// Strip "search views <query>" / "find view <query>"
	const match = text.match(
		/\b(?:search|find|look for|filter)\b.*?\bview[s]?\b\s+(.+)/i,
	);
	return match?.[1]?.trim() ?? text.trim();
}

export function createViewsAction(deps: ViewsActionDeps = {}): Action {
	const clientFactory = () => deps.client ?? createViewsClient();

	return {
		name: "VIEWS",
		contexts: ["general", "automation", "settings"],
		contextGate: { anyOf: ["general", "automation", "settings"] },
		roleGate: { minRole: "USER" },
		similes: [
			"VIEW",
			"SHOW_VIEW",
			"OPEN_VIEW",
			"LIST_VIEWS",
			"VIEW_MANAGER",
			"VIEWS_LIST",
			"SWITCH_VIEW",
			"CLOSE_VIEW",
			"SHOW_APPS",
			"OPEN_APPS",
			"GO_TO_VIEW",
			"NAVIGATE_TO_VIEW",
			"WHAT_VIEWS",
		],
		description:
			"Manage and navigate UI views. List available views, open a specific view, search views by name or capability, or show the view manager.",
		descriptionCompressed:
			"views list|show|open|search|manager; navigate UI views by name, id, or keyword",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "action",
				description: "Operation: list | show | open | search | manager.",
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
				name: "view",
				description: "View name, label, or id (show / open).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "id",
				description: "Alias for `view`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "name",
				description: "Alias for `view`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "query",
				description: "Search keyword (search mode).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "search",
				description: "Alias for `query`.",
				required: false,
				schema: { type: "string" },
			},
		],

		validate: async (
			_runtime: IAgentRuntime,
			_message: Memory,
		): Promise<boolean> => {
			// Views are visible to all users — no owner gate required for read operations.
			return true;
		},

		handler: async (
			runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const client = clientFactory();
			const text = message.content?.text ?? "";

			const mode = inferMode(text, options);
			if (!mode) {
				const reply =
					'Tell me what to do with views. Try: "list views", "open wallet view", or "search views finance".';
				await callback?.({ text: reply });
				return { success: false, text: reply };
			}

			logger.info(`[plugin-app-control] VIEWS mode=${mode}`);

			switch (mode) {
				case "list":
					return runViewsList({ client, callback });

				case "show":
				case "open":
					return runViewsShow({ client, message, options, callback });

				case "search": {
					const query = extractSearchQuery(text, options);
					return runViewsSearch({ client, query, callback });
				}

				case "manager": {
					// The view manager lives at "/views" (preferred) or "/apps".
					// Attempt navigation to it via the views API, same as show.
					// Synthesize a fake view summary for the manager page.
					const managerView = {
						id: "__view-manager__",
						label: "View Manager",
						path: "/views",
						pluginName: "core",
						available: true,
					};
					const resultText = await navigateToPath(
						managerView.path,
						managerView.label,
					);
					await callback?.({ text: resultText });
					return {
						success: true,
						text: resultText,
						values: { mode: "manager" },
						data: { view: managerView },
					};
				}
			}
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "list views" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "available_views:\n  count: 3\nviews[3]{id,label,path,available}:\n  wallet.inventory,Wallet,/wallet,yes\n  chat,Chat,/,yes\n  settings,Settings,/settings,yes",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "open wallet view" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Navigated to Wallet.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "search views finance" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Views matching "finance" (1):\n  [60] Wallet (wallet.inventory) — /wallet — Track your crypto balances.',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "open view manager" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Navigated to View Manager.",
						action: "VIEWS",
					},
				},
			],
		],
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the agent is running on a platform that prohibits dynamic
 * code loading (iOS App Store and Google Play builds).
 *
 * Reads ELIZA_BUILD_VARIANT and ELIZA_PLATFORM from the process environment —
 * the same variables the coding-tools plugin uses to gate shell support.
 */
export function isRestrictedPlatform(): boolean {
	const variant = (process.env.ELIZA_BUILD_VARIANT ?? "").trim().toLowerCase();
	if (variant === "store") return true;
	const platform = (process.env.ELIZA_PLATFORM ?? "").trim().toLowerCase();
	return platform === "ios" || platform === "android";
}

async function navigateToPath(path: string, label: string): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(`${base}/api/views/__view-manager__/navigate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path }),
			signal: AbortSignal.timeout(5_000),
		});
		if (resp.ok || resp.status === 501 || resp.status === 404) {
			return `Navigated to ${label}.`;
		}
		logger.warn(
			`[plugin-app-control] VIEWS/manager navigate returned ${resp.status}`,
		);
	} catch {
		// Network or timeout — not fatal.
	}

	return `Opened ${label} at ${path}.`;
}

export const viewsAction: Action = createViewsAction();
