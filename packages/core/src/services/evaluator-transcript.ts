/**
 * Shared room transcript for the merged post-turn evaluator call. Every
 * memory-extracting evaluator needs the complete conversation of the current
 * room; fetching it once per message (memoized by message identity) and
 * rendering it once in the shared prompt context replaces one unbounded
 * `messages` read and one rendered copy per active evaluator. The transcript
 * is complete and uncapped; synthetic conversation artifacts (system-authored
 * summaries, relays) are not conversation turns and are excluded everywhere.
 */

import {
	dedupeHygienicDialogueMessages,
	isHygienicDialogueMessage,
} from "../features/basic-capabilities/providers/recentMessages.ts";
import { renderStoredEnvelopesForPrompt } from "../security/external-content";
import type { IAgentRuntime, Memory } from "../types";
import { isSyntheticConversationArtifactMemory } from "../utils/synthetic-conversation-artifact.ts";

const transcriptsByRuntime = new WeakMap<
	IAgentRuntime,
	WeakMap<Memory, Promise<Memory[]>>
>();

/** Complete room transcript for the message's room, newest last. */
export function getRoomTranscript(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<Memory[]> {
	let transcriptByMessage = transcriptsByRuntime.get(runtime);
	if (!transcriptByMessage) {
		transcriptByMessage = new WeakMap();
		transcriptsByRuntime.set(runtime, transcriptByMessage);
	}
	const existing = transcriptByMessage.get(message);
	if (existing) return existing;
	const loading = runtime
		.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
		})
		.then((memories) =>
			// The same hygiene + dedupe pass the RECENT_MESSAGES transcript applies:
			// connector record-of-send rows duplicate every delivered reply (live
			// Discord: two identical agent rows per reply, ~100 ms apart), and the
			// merged post-turn prompt otherwise carries each of them.
			dedupeHygienicDialogueMessages(
				memories
					.filter(
						(memory) =>
							!isSyntheticConversationArtifactMemory(memory) &&
							isHygienicDialogueMessage(memory, runtime.agentId),
					)
					.sort((left, right) => {
						const l = Number.isFinite(left.createdAt ?? 0)
							? (left.createdAt ?? 0)
							: 0;
						const r = Number.isFinite(right.createdAt ?? 0)
							? (right.createdAt ?? 0)
							: 0;
						return (
							l - r ||
							String(left.id ?? "").localeCompare(String(right.id ?? ""))
						);
					}),
				runtime.agentId,
			),
		);
	transcriptByMessage.set(message, loading);
	// error-policy:J2 a failed read is not an empty room: drop the memo so the
	// next caller retries, and let the storage error reach the evaluator run.
	loading.catch(() => transcriptByMessage.delete(message));
	return loading;
}

export function formatRecentMessages(memories: Memory[]): string {
	const lines: string[] = [];
	for (const memory of memories) {
		if (isSyntheticConversationArtifactMemory(memory)) continue;
		const rawText = memory.content.text;
		if (typeof rawText !== "string" || !rawText.trim()) continue;
		const text = renderStoredEnvelopesForPrompt(rawText);
		const senderName =
			(typeof memory.content.senderName === "string" &&
				memory.content.senderName) ||
			(typeof memory.content.name === "string" && memory.content.name) ||
			memory.entityId ||
			"someone";
		lines.push(`- ${senderName}: ${text}`);
	}
	return lines.length > 0 ? lines.join("\n") : "(none)";
}

/** Heading the shared prompt context renders the transcript under. */
export const ROOM_TRANSCRIPT_HEADING = "Room transcript";

/**
 * What a section should print in place of its own transcript copy when the
 * shared context already carries it.
 */
export function recentMessagesSection(
	shared: { roomTranscriptRendered: boolean } | undefined,
	memories: Memory[],
): string {
	return shared?.roomTranscriptRendered
		? `Recent messages: see "${ROOM_TRANSCRIPT_HEADING}" in the Shared Turn Context above.`
		: `Recent messages:\n${formatRecentMessages(memories)}`;
}
