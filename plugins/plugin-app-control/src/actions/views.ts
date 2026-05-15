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
	| "broadcast"
	| "interact"
	| "pin"
	| "window";

const MODES: readonly ViewsMode[] = [
	"list",
	"show",
	"open",
	"search",
	"manager",
	"broadcast",
	"interact",
	"pin",
	"window",
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
const INTERACT_VERBS =
	/\b(click|tap|press|focus|fill|interact|invoke|call|use capability)\b.{0,60}\b(view|button|input|field)\b/i;

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

	if (INTERACT_VERBS.test(trimmed)) return "interact";
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
			"INTERACT_WITH_VIEW",
			"CLICK_IN_VIEW",
			"INVOKE_VIEW_CAPABILITY",
			"PIN_VIEW",
			"OPEN_VIEW_WINDOW",
		],
		description:
			"Manage and navigate UI views. List available views, open a specific view, search views by name or capability, show the view manager, broadcast events to views, interact with a mounted view, pin a view as a desktop tab, or open a view in a separate window.",
		descriptionCompressed:
			"views list|show|open|search|manager|broadcast|interact|pin|window; navigate UI views; push events; click/read/focus elements; pin desktop tabs; open in window",
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
			{
				name: "capability",
				description:
					"Capability to invoke on the view (interact mode), e.g. 'click-button', 'get-state', 'get-text', 'refresh', 'focus-element'.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "params",
				description:
					"Parameters for the capability (interact mode), e.g. { buttonId: 'submit' } or { selector: '#my-input' }.",
				required: false,
				schema: { type: "object" },
			},
			{
				name: "timeoutMs",
				description: "Timeout in ms for interact responses. Default 5000.",
				required: false,
				schema: { type: "number" },
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
							"Specify an event type to broadcast, e.g. action=broadcast eventType=wallet:refresh.";
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

				case "interact": {
					// Resolve the view ID from options or text.
					const viewId =
						readStringOption(options, "view") ??
						readStringOption(options, "id") ??
						readStringOption(options, "name");
					const capability = readStringOption(options, "capability");
					if (!viewId || !capability) {
						const reply =
							"Specify view and capability, e.g. action=interact view=wallet capability=get-state.";
						await callback?.({ text: reply });
						return { success: false, text: reply };
					}
					const params =
						options?.params !== null &&
						typeof options?.params === "object" &&
						!Array.isArray(options?.params)
							? (options.params as Record<string, unknown>)
							: undefined;
					const timeoutMs =
						typeof options?.timeoutMs === "number" && options.timeoutMs > 0
							? options.timeoutMs
							: 5_000;
					const resultText = await interactWithView(
						viewId,
						capability,
						params,
						timeoutMs,
					);
					await callback?.({ text: resultText });
					return {
						success: true,
						text: resultText,
						values: { mode: "interact", viewId, capability },
						data: { viewId, capability, params },
					};
				}

				case "pin": {
					// Resolve target view and ask the shell to pin it as a desktop tab.
					// The shell listens for POST /api/views/:id/navigate with action=pin-tab.
					const pinViewId =
						readStringOption(options, "view") ??
						readStringOption(options, "id") ??
						readStringOption(options, "name");
					if (!pinViewId) {
						const reply =
							"Specify which view to pin as a desktop tab, e.g. action=pin view=wallet.";
						await callback?.({ text: reply });
						return { success: false, text: reply };
					}
					const pinResultText = await pinViewAsTab(pinViewId);
					await callback?.({ text: pinResultText });
					return {
						success: true,
						text: pinResultText,
						values: { mode: "pin", viewId: pinViewId },
						data: { viewId: pinViewId },
					};
				}

				case "window": {
					// Resolve target view and ask the shell to open it in a separate window.
					const windowViewId =
						readStringOption(options, "view") ??
						readStringOption(options, "id") ??
						readStringOption(options, "name");
					if (!windowViewId) {
						const reply =
							"Specify which view to open in a new window, e.g. action=window view=wallet.";
						await callback?.({ text: reply });
						return { success: false, text: reply };
					}
					const windowResultText = await openViewInWindow(windowViewId);
					await callback?.({ text: windowResultText });
					return {
						success: true,
						text: windowResultText,
						values: { mode: "window", viewId: windowViewId },
						data: { viewId: windowViewId },
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
					content: { text: "click the submit button in the wallet view" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Interacted with view "wallet.inventory" — capability "focus-element": {"focused":true,"selector":"submit"}.',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "get the state of the settings view" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Interacted with view "settings" — capability "get-state": {"theme":"dark","language":"en"}.',
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
 * POST /api/views/:id/interact — invoke a capability on a mounted view and
 * return the result.  Waits up to timeoutMs for the frontend to respond.
 */
async function _interactWithView(
	viewId: string,
	capability: string,
	params: Record<string, unknown> | undefined,
	timeoutMs: number,
): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	let resp: Response;
	try {
		resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/interact`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ capability, params, timeoutMs }),
				signal: AbortSignal.timeout(timeoutMs + 1_000),
			},
		);
	} catch (err) {
		logger.warn(
			`[plugin-app-control] VIEWS/interact network error: ${err instanceof Error ? err.message : String(err)}`,
		);
		return `Failed to interact with view "${viewId}": network error.`;
	}

	if (resp.status === 504) {
		return `View "${viewId}" did not respond to capability "${capability}" within ${timeoutMs}ms.`;
	}
	if (resp.status === 404) {
		return `View "${viewId}" not found or not mounted.`;
	}
	if (resp.status === 400) {
		let detail = "";
		try {
			const body = (await resp.json()) as Record<string, unknown>;
			detail = typeof body.error === "string" ? ` — ${body.error}` : "";
		} catch {
			/* ignore */
		}
		return `Cannot invoke capability "${capability}" on view "${viewId}"${detail}.`;
	}
	if (!resp.ok) {
		logger.warn(
			`[plugin-app-control] VIEWS/interact returned ${resp.status} for view "${viewId}"`,
		);
		return `Interact with view "${viewId}" failed (HTTP ${resp.status}).`;
	}

	let result: unknown;
	try {
		result = await resp.json();
	} catch {
		return `Interacted with view "${viewId}" (capability "${capability}") — no parseable result.`;
	}

	const resultStr =
		result !== null && result !== undefined ? JSON.stringify(result) : "null";
	return `Interacted with view "${viewId}" — capability "${capability}": ${resultStr}.`;
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
		logger.warn(`[plugin-app-control] VIEWS/broadcast returned ${resp.status}`);
	} catch {
		// Network or timeout — not fatal.
	}

	return `Attempted to broadcast view event "${eventType}".`;
}

/**
 * POST /api/views/:viewId/pin-tab — ask the shell to pin the view as a
 * persistent desktop tab.
 */
async function pinViewAsTab(viewId: string): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/navigate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "pin-tab" }),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (resp.ok || resp.status === 501 || resp.status === 404) {
			return `Pinned view "${viewId}" as a desktop tab.`;
		}
		logger.warn(
			`[plugin-app-control] VIEWS/pin returned ${resp.status} for ${viewId}`,
		);
	} catch {
		// Network or timeout — not fatal.
	}

	return `Requested to pin view "${viewId}" as a tab.`;
}

/**
 * POST /api/views/:viewId/open-window — ask the shell to open the view in a
 * separate window.
 */
async function openViewInWindow(viewId: string): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/navigate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "open-window" }),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (resp.ok || resp.status === 501 || resp.status === 404) {
			return `Opened view "${viewId}" in a new window.`;
		}
		logger.warn(
			`[plugin-app-control] VIEWS/window returned ${resp.status} for ${viewId}`,
		);
	} catch {
		// Network or timeout — not fatal.
	}

	return `Requested to open view "${viewId}" in a new window.`;
}

/**
 * POST /api/views/:viewId/interact — invoke a named capability on a specific
 * view and return the result text.
 */
async function interactWithView(
	viewId: string,
	capability: string,
	params: Record<string, unknown> | undefined,
	timeoutMs: number,
): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/interact`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ capability, params }),
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		if (resp.ok) {
			const body = (await resp.json()) as { result?: string };
			return (
				body.result ?? `View "${viewId}" handled capability "${capability}".`
			);
		}
		logger.warn(
			`[plugin-app-control] VIEWS/interact returned ${resp.status} for ${viewId}/${capability}`,
		);
	} catch {
		// Network or timeout — not fatal.
	}

	return `Sent "${capability}" to view "${viewId}".`;
}

export const viewsAction: Action = createViewsAction();
