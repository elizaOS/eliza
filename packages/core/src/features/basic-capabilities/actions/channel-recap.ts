/**
 * CHANNEL_RECAP — reads back the recent stored message history of the room the
 * triggering message arrived in, so a group-chat sender can ask for a recap,
 * summary, or "the last N messages" of their own channel. Live evidence
 * 2026-08-21: that ask routed to contexts=["general"], whose planner surface
 * carried no message-history tool (SEARCH_MESSAGES lives behind the ADMIN
 * messaging/email umbrella), so the agent honestly refused a request whose
 * content every room participant can already scroll.
 *
 * Room scoping is structural, not parametric: the handler reads only
 * `message.roomId` and exposes no room/channel selector, so a request from
 * room A can never return room B content and cross-room/inbox-wide search
 * stays gated on the messaging umbrella exactly as before. The returned text
 * is model-facing and complete — every rendered message carries its full
 * stored text, chronologically ordered. The only bound is
 * `CHANNEL_RECAP_MAX_FETCH`, a documented storage read bound on how many rows
 * are pulled (never a text cap); exceeding it is reported explicitly in the
 * result rather than silently clamped.
 */
import { getEntityDetails } from "../../../entities.ts";
import { isInternalBridgeMessage } from "../../../messaging/automated-turns.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	AgentContext,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import { formatMessages } from "../../../utils.ts";
import { ensureFormattingEntities } from "../providers/recentMessages.ts";

export const CHANNEL_RECAP_CONTEXTS = ["general"] satisfies AgentContext[];

/** Messages rendered when the caller does not name a count. */
export const CHANNEL_RECAP_DEFAULT_COUNT = 50;

/**
 * Storage read bound: the most rows a single recap pulls from the message
 * store. A read bound on the DB fetch, not a cap on rendered text — every
 * retained message is rendered complete. Requests above it fail explicitly
 * without returning a partial transcript.
 */
export const CHANNEL_RECAP_MAX_FETCH = 500;

function resolveRequestedCount(options?: HandlerOptions): number | undefined {
	const raw =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>).count
			: undefined;
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
	// Same integer-digits-only rule as the offset parser: "50.9" or "1e2" is a
	// malformed count, not a request — fall back to the default.
	if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
		return Number(raw.trim());
	}
	return undefined;
}

export const channelRecapAction: Action = {
	name: "CHANNEL_RECAP",
	contexts: [...CHANNEL_RECAP_CONTEXTS],
	// Deliberately no roleGate: this is the CURRENT room's transcript — content
	// every participant can already read in their client (same GUEST-floor
	// rationale as the RECENT_MESSAGES provider). Cross-room and inbox-wide
	// reads stay on the ADMIN-gated MESSAGE umbrella.
	description:
		"Read back the recent message history of the CURRENT room/channel — the conversation this request arrived in — complete and in chronological order, so the reply can summarize, recap, or quote it: 'summarize this chat', 'recap the channel', 'what were the last 100 messages', 'what did people say here earlier'. Always scoped to this room only; searching other rooms, channels, or inboxes stays on MESSAGE.",
	descriptionCompressed:
		"read current room's own recent history for recap/summary/last-N-messages; this room only, cross-channel search stays on MESSAGE",
	routingHint:
		"recap/summarize/read back THIS chat's history -> CHANNEL_RECAP; cross-channel or inbox search -> MESSAGE (NOT this action)",
	similes: [
		"ROOM_HISTORY",
		"CHAT_HISTORY",
		"SUMMARIZE_CHAT",
		"RECAP_CHANNEL",
		"READ_RECENT_ROOM_MESSAGES",
		"LAST_MESSAGES",
	],
	parameters: [
		{
			name: "offset",
			description:
				"How many newest messages to skip before reading (default 0). Use the continuation offset a previous recap reported to page into older history.",
			schema: { type: "number", minimum: 0 },
			required: false,
		},
		{
			name: "count",
			description: `How many most-recent messages to read back (default ${CHANNEL_RECAP_DEFAULT_COUNT}; storage read bound ${CHANNEL_RECAP_MAX_FETCH}).`,
			required: false,
			schema: {
				type: "number" as const,
				minimum: 1,
				maximum: CHANNEL_RECAP_MAX_FETCH,
			},
		},
	],
	examples: [
		[
			{
				name: "User",
				content: {
					text: "what were the last 100 messages in this chat? give me a summary",
				},
			},
			{
				name: "Agent",
				content: {
					text: "Reading back this channel's history.",
					action: "CHANNEL_RECAP",
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		hasActionContext(message, state, { contexts: CHANNEL_RECAP_CONTEXTS }),

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<ActionResult> => {
		const roomId = message.roomId;
		if (!roomId) {
			return {
				success: false,
				text: "CHANNEL_RECAP requires a room-bound message; this message has no roomId.",
				values: { success: false },
				data: { actionName: "CHANNEL_RECAP" },
			};
		}

		const requestedCount = resolveRequestedCount(options);
		const rawOffset = (
			options?.parameters as Record<string, unknown> | undefined
		)?.offset;
		const parsedOffset =
			typeof rawOffset === "number"
				? rawOffset
				: typeof rawOffset === "string" && /^\d+$/.test(rawOffset.trim())
					? Number(rawOffset.trim())
					: 0;
		const offset =
			Number.isFinite(parsedOffset) && parsedOffset > 0
				? Math.floor(parsedOffset)
				: 0;
		const validRequested =
			requestedCount !== undefined && requestedCount >= 1
				? requestedCount
				: undefined;
		const fetchCount = Math.min(
			validRequested ?? CHANNEL_RECAP_DEFAULT_COUNT,
			CHANNEL_RECAP_MAX_FETCH,
		);
		if (
			validRequested !== undefined &&
			validRequested > CHANNEL_RECAP_MAX_FETCH
		) {
			return {
				success: false,
				text: `CHANNEL_RECAP count ${validRequested} exceeds the complete storage read bound of ${CHANNEL_RECAP_MAX_FETCH}; request at most ${CHANNEL_RECAP_MAX_FETCH}.`,
				values: { success: false },
				data: {
					actionName: "CHANNEL_RECAP",
					error: "CHANNEL_RECAP_COUNT_TOO_LARGE",
				},
			};
		}
		const requestedDepth = fetchCount + offset;
		if (
			!Number.isSafeInteger(offset) ||
			requestedDepth > CHANNEL_RECAP_MAX_FETCH
		) {
			return {
				success: false,
				text: `CHANNEL_RECAP count + offset must not exceed the maximum complete read of ${CHANNEL_RECAP_MAX_FETCH}.`,
				values: { success: false },
				data: {
					actionName: "CHANNEL_RECAP",
					error: "CHANNEL_RECAP_RANGE_TOO_LARGE",
				},
			};
		}

		// Newest-first from the store (adapter default order); formatMessages
		// walks its input from the last element backwards, so passing the
		// newest-first rows renders the transcript oldest-first (chronological).
		// Read the whole bounded raw scope before applying dialogue filters. If
		// filtering happened after a count-sized fetch, machinery rows would
		// silently displace older dialogue that the caller requested.
		const rows = await runtime.getMemories({
			tableName: "messages",
			roomId,
			count: CHANNEL_RECAP_MAX_FETCH,
			unique: false,
		});

		// Strip only the agent's own structural machinery rows: action_result
		// records and internal bridge relays. This is a SUBSET of the
		// RECENT_MESSAGES filter (which additionally strips synthetic failure
		// replies, transient status posts, leaked tool transcripts/path dumps,
		// and dedupes) — a recap is a verbatim read-back, so only rows that are
		// never conversation are removed. Every retained row renders complete.
		const allDialogue = rows.filter(
			(row) =>
				row.content?.type !== "action_result" && !isInternalBridgeMessage(row),
		);
		// Caller-requested pagination is applied to dialogue, not raw storage
		// rows, so internal machinery cannot silently consume the requested count.
		if (
			rows.length === CHANNEL_RECAP_MAX_FETCH &&
			allDialogue.length < requestedDepth
		) {
			return {
				success: false,
				text: `CHANNEL_RECAP could not produce the requested complete dialogue range within the ${CHANNEL_RECAP_MAX_FETCH}-row storage read bound because non-dialogue rows occupy the range. Narrow the request.`,
				values: { success: false },
				data: {
					actionName: "CHANNEL_RECAP",
					error: "CHANNEL_RECAP_COMPLETE_RANGE_UNAVAILABLE",
				},
			};
		}
		const dialogue = allDialogue.slice(offset, requestedDepth);

		const roomEntities = await getEntityDetails({ runtime, roomId });
		const entities = await ensureFormattingEntities(
			runtime,
			roomEntities,
			dialogue,
		);
		const transcript = formatMessages({ messages: dialogue, entities });

		// Store-exhaustion is measured against the full fetch depth
		// (count + offset): with a nonzero offset the store can satisfy
		// `fetchCount` rows and still be exhausted short of the requested page.
		const depthNote =
			rows.length < requestedDepth
				? ` This room's stored history holds ${rows.length} message(s); the read requested up to ${requestedDepth}${
						offset > 0 ? ` (count ${fetchCount} + offset ${offset})` : ""
					}.`
				: "";
		const rangeLabel =
			offset > 0
				? `messages ${offset + 1}–${offset + dialogue.length} back (newest first)`
				: `the last ${dialogue.length} stored message(s)`;
		const text =
			dialogue.length === 0
				? `No stored messages found in this room's history at offset ${offset}.${depthNote}`
				: `Complete transcript of ${rangeLabel} in this room, oldest first:${depthNote}\n\n${transcript}`;

		return {
			success: true,
			text,
			values: { success: true, messageCount: dialogue.length },
			data: {
				actionName: "CHANNEL_RECAP",
				roomId,
				scope: {
					roomScoped: true,
					requestedCount: validRequested ?? null,
					fetchCount,
					offset,
					storageReadBound: CHANNEL_RECAP_MAX_FETCH,
					fetchedRows: rows.length,
					renderedCount: dialogue.length,
					order: "chronological",
				},
				messages: dialogue
					.slice()
					.reverse()
					.map((row) => ({
						id: row.id ?? null,
						entityId: row.entityId,
						createdAt: row.createdAt ?? null,
						// Complete stored text — never a snippet.
						text: row.content?.text ?? "",
					})),
			},
		};
	},
};
