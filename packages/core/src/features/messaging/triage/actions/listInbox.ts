/**
 * Read-only triage action that returns unread messages across every connected
 * platform as one recency-sorted feed with structural signals attached; the
 * model reading the result judges urgency (#14716). Registered under the
 * shared `MESSAGE` action name; serves cached refs from the TriageService
 * store when present (re-ranked via `rankScored`) and otherwise triggers a
 * live `triage()` pull, then filters to unread and trims to the requested
 * limit. ADMIN-gated and side-effect free — it never drafts or mutates.
 */

import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { rankScored } from "../triage-engine.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import { ALL_MESSAGE_SOURCES } from "../types.ts";
import {
	describeMessageScope,
	parseListInboxParams,
	validateMessageAction,
} from "./_shared.ts";

export const listInboxAction: Action = {
	name: "MESSAGE",
	contexts: ["messaging", "email", "connectors"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Read-only list of unread messages from every connected platform as one feed, newest first with sender relationship weight attached. Use when the user asks 'what's in my inbox across everything' or 'show me unread across all platforms'. Do not use as the first step for respond/reply-to-inbox or needs-answer requests; use MESSAGE so reply-worthy messages are identified before drafting.",
	similes: ["LIST_MESSAGES", "SHOW_UNREAD_ACROSS"],
	parameters: [
		{
			name: "sources",
			description:
				"Optional message sources to include, such as email, slack, discord, imessage, signal, whatsapp, telegram, or x.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const, enum: [...ALL_MESSAGE_SOURCES] },
			},
		},
		{
			name: "limit",
			description: "Maximum unread messages to return.",
			required: false,
			schema: { type: "number" as const, minimum: 1, maximum: 100 },
		},
		{
			name: "sinceMs",
			description: "Only include messages received at or after this timestamp.",
			required: false,
			schema: { type: "number" as const },
		},
	],
	examples: [
		[
			{
				name: "User",
				content: { text: "Show me unread across all platforms" },
			},
			{
				name: "Agent",
				content: {
					text: "Here's your inbox.",
					action: "MESSAGE",
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		validateMessageAction(message, state, ["messaging", "email", "connectors"]),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		_callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
			const params = parseListInboxParams(options);
			const service = getDefaultTriageService();
			const store = service.getStore();

			const cached = store.listMessages();
			const requestedSources = params.sources;
			let messages = requestedSources
				? cached.filter((m) => requestedSources.includes(m.source))
				: cached;

			let usedTriageFallback = false;
			if (messages.length === 0) {
				usedTriageFallback = true;
				messages = await service.triage(runtime, {
					sources: params.sources,
					sinceMs: params.sinceMs,
					limit: params.limit,
				});
			} else {
				messages = rankScored(messages);
			}

			const unread = messages.filter((m) => !m.isRead);
			const limit = params.limit ?? unread.length;
			const trimmed = unread.slice(0, limit);

			logger.info(
				`[ListInbox] returning ${trimmed.length} of ${unread.length} unread message(s)`,
			);

			// No visible callback: the bare count is tool-speak next to the
			// evaluator's actual inbox rundown. The summary stays planner-facing
			// in the result text with the messages in data.
			//
			// The feed is narrowed by requested sources, sinceMs, and limit before
			// the unread filter runs, so an empty result claiming "across connected
			// platforms" reports a clear inbox while unread mail sits in the
			// sources that were filtered away. Name the scope and the counts that
			// were actually measured.
			// Announce ONLY the narrowings this path actually performed.
			// Declaring a filter that never ran replaces one false statement with
			// another: worldIds/channelIds are parsed but nothing here applies
			// them, and sinceMs is applied by the triage fallback alone — the
			// cached read (`store.listMessages()`) takes no arguments. Announcing
			// them produced a self-contradicting sentence that claimed a since-
			// window while counting a message older than it as "in scope".
			const scope = describeMessageScope({
				requestedSources: params.sources,
				registeredSources: service.listRegisteredSources(),
				...(usedTriageFallback ? { sinceMs: params.sinceMs } : {}),
				limit: params.limit,
			});
			const text =
				trimmed.length === 0
					? `No unread messages in the checked scope (${scope}); ${messages.length} message(s) were in scope, none unread. This is a scoped view, not a statement that the whole inbox is clear — drop the filters to check every connected platform.`
					: `${unread.length} unread message(s) across ${new Set(unread.map((m) => m.source)).size} platform(s) in the checked scope (${scope}); showing ${trimmed.length} in data.messages.`;

			return {
				success: true,
				text,
				data: {
					total: unread.length,
					returned: trimmed.length,
					messages: trimmed.map((m) => ({
						id: m.id,
						source: m.source,
						from: m.from.identifier,
						subject: m.subject ?? null,
						snippet: m.snippet,
						receivedAtMs: m.receivedAtMs,
						contactWeight: m.triageScore?.contactWeight ?? null,
						userRepliedInThread: m.triageScore?.userRepliedInThread ?? null,
					})),
				},
			};
		} catch (error) {
			// error-policy:J1 The action result is the model-visible boundary for
			// connector and inbox-read failures.
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`[ListInbox] failed: ${message}`);
			return {
				success: false,
				text: `Failed to list inbox: ${message}`,
				error: message,
				data: { actionName: "MESSAGE" },
			};
		}
	},
};
