/**
 * Computes the active-conversation continuity signal consumed by the
 * personality reply-gate's on_mention mode: true only when the agent's most
 * recent message in this room is fresh AND was engaged with the current
 * sender. Fails CLOSED (false) on lookup errors so a storage hiccup can never
 * relax the over-reply mitigation.
 */
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";

/** Follow-ups older than this are a new approach, not a continuation. */
export const CONTINUITY_WINDOW_MS = 5 * 60_000;
/** Recent-history scan depth — matches bot-noise-triage's shallow window. */
export const CONTINUITY_SCAN_COUNT = 10;

export async function senderInActiveConversation(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<boolean> {
	let recent: Memory[];
	try {
		recent = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			count: CONTINUITY_SCAN_COUNT,
		});
	} catch (error) {
		// error-policy:J4 continuity is an optional relaxation of the reply
		// gate; on lookup failure the gate keeps its strict on_mention
		// behavior (fail closed) and the failure surfaces via RECENT_ERRORS.
		runtime.reportError("ReplyGateContinuity.history", error, {
			roomId: message.roomId,
		});
		return false;
	}
	const history = recent
		.filter((m) => m.id !== message.id)
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)); // newest first
	const agentLast = history.find((m) => m.entityId === runtime.agentId);
	if (!agentLast) return false;
	// message.createdAt as "now" keeps the TTL deterministic in tests;
	// Date.now() is only the live fallback for unstamped memories.
	const now =
		typeof message.createdAt === "number" ? message.createdAt : Date.now();
	if (now - (agentLast.createdAt ?? 0) > CONTINUITY_WINDOW_MS) return false;
	// Engaged with THIS sender: the agent message reply-links to one of the
	// sender's messages, or the nearest preceding non-agent message (the turn
	// the agent was answering) is the sender's.
	const inReplyTo = agentLast.content?.inReplyTo;
	if (
		inReplyTo &&
		history.some((m) => m.id === inReplyTo && m.entityId === message.entityId)
	) {
		return true;
	}
	const agentIdx = history.indexOf(agentLast);
	const answered = history
		.slice(agentIdx + 1) // older than agentLast, newest first
		.find((m) => m.entityId !== runtime.agentId);
	return answered?.entityId === message.entityId;
}
