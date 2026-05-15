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
import { readStringOption } from "../params.js";
import { createViewsClient, type ViewsClient } from "./views-client.js";
import { runViewsList } from "./views-list.js";
import { runViewsSearch } from "./views-search.js";
import { runViewsShow } from "./views-show.js";

export type ViewsMode =
	| "list"
	| "show"
	| "open"
	| "search"
	| "manager"
	| "broadcast";

const MODES: readonly ViewsMode[] = [
	"list",
	"show",
	"open",
	"search",
	"manager",
	"broadcast",
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
const BROADCAST_VERBS =
	/\b(tell|notify|signal|broadcast|send.*event|emit|trigger|ping)\b.{0,60}\bview\b/i;

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

	if (BROADCAST_VERBS.test(trimmed)) return "broadcast";
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
			"BROADCAST_VIEW_EVENT",
			"NOTIFY_VIEW",
			"SIGNAL_VIEW",
		],
		description:
			"Manage and navigate UI views. List available views, open a specific view, search views by name or capability, show the view manager, or broadcast an event to all mounted views.",
		descriptionCompressed:
			"views list|show|open|search|manager|broadcast; navigate UI views by name, id, or keyword; push events to views",
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "action",
				description:
					"Operation: list | show | open | search | manager | broadcast.",
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
			{
				name: "eventType",
				description:
					"Event type to broadcast to all mounted views (broadcast mode), e.g. 'wallet:refresh'.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "payload",
				description: "JSON payload to include with the broadcast event.",
				required: false,
				schema: { type: "object" },
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
			_runtime: IAgentRuntime,
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

				case "broadcast": {
					const eventType =
						readStringOption(options, "eventType") ??
						readStringOption(options, "event") ??
						readStringOption(options, "type");
					if (!eventType) {
						const reply =
							'Specify an event type to broadcast, e.g. action=broadcast eventType=wallet:refresh.';
						await callback?.({ text: reply });
						return { success: false, text: reply };
					}
					const payload =
						options?.payload !== null &&
						typeof options?.payload === "object" &&
						!Array.isArray(options?.payload)
							? (options.payload as Record<string, unknown>)
							: {};
					const resultText = await broadcastViewEvent(eventType, payload);
					await callback?.({ text: resultText });
					return {
						success: true,
						text: resultText,
						values: { mode: "broadcast", eventType },
						data: { eventType, payload },
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
			[
				{
					name: "{{user1}}",
					content: { text: "tell the wallet view to refresh" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Broadcast view event "wallet:refresh" to all connected views.',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "what views are available?" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "available_views:\n  count: 2\nviews[2]{id,label,path,available}:\n  wallet.inventory,Wallet,/wallet,yes\n  settings,Settings,/settings,yes",
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

/**
 * POST /api/views/events/broadcast — push a view event to all connected
 * frontend tabs via the server's WebSocket broadcast.
 */
async function broadcastViewEvent(
	eventType: string,
	payload: Record<string, unknown>,
): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(`${base}/api/views/events/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: eventType, payload }),
			signal: AbortSignal.timeout(5_000),
		});
		if (resp.ok) {
			return `Broadcast view event "${eventType}" to all connected views.`;
		}
		logger.warn(
			`[plugin-app-control] VIEWS/broadcast returned ${resp.status}`,
		);
	} catch {
		// Network or timeout — not fatal.
	}

	return `Attempted to broadcast view event "${eventType}".`;
}

export const viewsAction: Action = createViewsAction();
