/**
 * Auto-Compaction Service
 *
 * Provides an async fire-and-forget compaction trigger for the recentMessages
 * provider. When the conversation token budget is exceeded, this module
 * summarises the older portion of the conversation and sets a compaction
 * point on the room so future context loads skip the summarised history.
 *
 * Key design choices:
 * - Records the compaction timestamp **before** the LLM summarisation call
 *   so that messages arriving during the (potentially slow) summary are
 *   guaranteed to appear after the compaction point.
 * - Prevents concurrent compactions for the same room via an in-progress set.
 * - Stores the summary as a regular message (source: "compaction") so
 *   the recentMessages provider includes it in future context windows.
 */

import { logger } from "../../../logger.ts";
import type { IAgentRuntime, JsonValue, UUID } from "../../../types/index.ts";
import { MemoryType, ModelType } from "../../../types/index.ts";

/** Rooms currently being compacted — prevents duplicate work. */
const compactionsInProgress = new Set<string>();

/**
 * Trigger an asynchronous compaction for the given room.
 * Safe to call from hot paths — returns immediately if a compaction
 * is already running for this room.
 */
export async function triggerAutoCompaction(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<void> {
	const key = `${runtime.agentId}:${roomId}`;
	if (compactionsInProgress.has(key)) {
		logger.debug(
			{ src: "auto-compaction", roomId },
			"Compaction already in progress, skipping",
		);
		return;
	}

	compactionsInProgress.add(key);
	try {
		await performCompaction(runtime, roomId);
	} finally {
		compactionsInProgress.delete(key);
	}
}

/**
 * Maximum characters to include in the summarisation prompt.
 * ~25 000 tokens at ~3 chars/token — well within TEXT_LARGE limits.
 */
const MAX_SUMMARY_INPUT_CHARS = 75_000;

async function performCompaction(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<void> {
	// Capture the timestamp BEFORE any async work so messages arriving during
	// compaction will have a createdAt greater than this value.
	const compactionTimestamp = Date.now();

	logger.info(
		{ src: "auto-compaction", roomId, timestamp: compactionTimestamp },
		"Starting auto-compaction",
	);

	// Check for existing compaction point so we only summarise NEW messages
	const room = await runtime.getRoom(roomId);
	const lastCompactionAt = room?.metadata?.lastCompactionAt as
		| number
		| undefined;

	// Load messages since last compaction (up to 200)
	const messages = await runtime.getMemories({
		tableName: "messages",
		roomId,
		count: 200,
		start: lastCompactionAt,
	});

	if (!messages?.length) {
		logger.debug({ src: "auto-compaction", roomId }, "No messages to compact");
		return;
	}

	// Format for summarisation — oldest first
	const sorted = messages.sort(
		(a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
	);
	let formatted = sorted
		.map((m) => {
			const role = m.entityId === runtime.agentId ? "Assistant" : "User";
			const text = typeof m.content?.text === "string" ? m.content.text : "";
			return `${role}: ${text}`;
		})
		.join("\n");

	// Truncate to stay within the model's context when summarising.
	// Keep the most recent portion so the summary captures the latest state.
	if (formatted.length > MAX_SUMMARY_INPUT_CHARS) {
		logger.info(
			{
				src: "auto-compaction",
				roomId,
				originalChars: formatted.length,
				truncatedTo: MAX_SUMMARY_INPUT_CHARS,
			},
			"Truncating conversation for summarisation",
		);
		formatted = formatted.slice(-MAX_SUMMARY_INPUT_CHARS);
	}

	// Carry forward the previous summary so incremental compaction doesn't
	// lose older context.  Find the most recent compaction summary message.
	let previousSummary = "";
	if (lastCompactionAt) {
		const compactionMsg = sorted.find(
			(m) => m.content?.source === "compaction",
		);
		if (compactionMsg?.content?.text) {
			previousSummary = compactionMsg.content.text;
		}
	}

	const summaryPreamble = previousSummary
		? `Previous context summary:\n${previousSummary}\n\n`
		: "";

	const prompt =
		`${summaryPreamble}Summarize this conversation for context preservation. Focus on decisions, ` +
		"facts learned, open questions, action items, and key context needed to continue.\n\n" +
		`Conversation:\n${formatted}\n\nSummary:`;

	const summary: string = await runtime.useModel(ModelType.TEXT_LARGE, {
		prompt,
		maxTokens: 2_000,
	});

	// Store the summary as a message right at the compaction point
	await runtime.createMemory(
		{
			id: globalThis.crypto.randomUUID() as UUID,
			entityId: runtime.agentId,
			roomId,
			content: {
				text: `[Compaction Summary]\n\n${summary}`,
				source: "compaction",
			},
			createdAt: compactionTimestamp,
			metadata: { type: MemoryType.CUSTOM },
		},
		"messages",
	);

	// Update room metadata with the compaction point
	if (room) {
		const prev = Array.isArray(room.metadata?.compactionHistory)
			? (room.metadata.compactionHistory as JsonValue[])
			: [];
		const entry: JsonValue = {
			timestamp: compactionTimestamp,
			triggeredBy: "auto-compaction",
		};
		const compactionHistory: JsonValue[] = [...prev, entry].slice(-10);
		await runtime.updateRoom({
			...room,
			metadata: {
				...room.metadata,
				lastCompactionAt: compactionTimestamp,
				compactionHistory,
			},
		});
	}

	logger.info(
		{
			src: "auto-compaction",
			roomId,
			compactionAt: compactionTimestamp,
			messageCount: messages.length,
		},
		"Auto-compaction complete",
	);
}
