/**
 * Active-conversation continuity for the personality reply-gate's on_mention
 * mode. Continuity is a typed per-room anchor written ONLY after a successfully
 * delivered, transcript-visible reply to a human sender — never inferred from
 * recent message history (IGNORE/STOP/action_result rows, rejected deliveries,
 * truncated windows, and untrusted event timestamps all make transcript
 * inference unsafe). Fails CLOSED (false) on cache read errors so a storage
 * hiccup can never relax the over-reply mitigation.
 */
import type { Memory } from "../../types/memory";
import type { Content, UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";

/** Follow-ups older than this are a new approach, not a continuation. */
export const CONTINUITY_WINDOW_MS = 5 * 60_000;

/** Cache schema version — bump if the stored shape changes. */
export const CONTINUITY_ANCHOR_VERSION = 1 as const;

export type OnMentionContinuityAnchor = {
	v: typeof CONTINUITY_ANCHOR_VERSION;
	/** Human sender the most recent delivered visible reply engaged. */
	senderId: UUID;
	/** Authoritative wall-clock receipt time of that successful delivery. */
	deliveredAt: number;
};

export function continuityAnchorCacheKey(agentId: UUID, roomId: UUID): string {
	return `on_mention_continuity:${agentId}:${roomId}`;
}

/**
 * True when outbound content is a transcript-visible engagement reply that may
 * open the on_mention continuity window. Internal rows, terminal silence
 * (IGNORE/STOP without user text), and action_result bookkeeping never qualify.
 */
export function isTranscriptVisibleEngagement(
	content: Content | null | undefined,
): boolean {
	if (!content || typeof content !== "object") return false;
	if (content.transcriptVisibility === "internal") return false;
	const typed = content as Content & { type?: unknown };
	if (typed.type === "action_result") return false;
	const text = typeof content.text === "string" ? content.text.trim() : "";
	if (!text) return false;
	const actions = Array.isArray(content.actions)
		? content.actions.map((a) => String(a).toUpperCase())
		: [];
	// Pure terminal silence must not refresh continuity even if a thought leaked
	// into text somehow — require that IGNORE/STOP is not the sole action set
	// unless REPLY (or no actions) is also present with real text.
	const hasTerminal = actions.some((a) => a === "IGNORE" || a === "STOP");
	const hasReply = actions.some((a) => a === "REPLY");
	if (hasTerminal && !hasReply) return false;
	return true;
}

function isContinuityAnchor(
	value: unknown,
): value is OnMentionContinuityAnchor {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<OnMentionContinuityAnchor>;
	return (
		v.v === CONTINUITY_ANCHOR_VERSION &&
		typeof v.senderId === "string" &&
		v.senderId.length > 0 &&
		typeof v.deliveredAt === "number" &&
		Number.isFinite(v.deliveredAt)
	);
}

/**
 * Persist the room's current engagement target after a successful user-visible
 * delivery. Best-effort: a cache write failure must not break the turn.
 */
export async function recordOnMentionContinuityAnchor(
	runtime: Pick<IAgentRuntime, "agentId" | "setCache" | "reportError">,
	args: {
		roomId: UUID;
		senderId: UUID;
		/** Authoritative processing clock; defaults to Date.now(). */
		deliveredAt?: number;
	},
): Promise<void> {
	if (!args.roomId || !args.senderId) return;
	if (args.senderId === runtime.agentId) return;
	const deliveredAt =
		typeof args.deliveredAt === "number" && Number.isFinite(args.deliveredAt)
			? args.deliveredAt
			: Date.now();
	const anchor: OnMentionContinuityAnchor = {
		v: CONTINUITY_ANCHOR_VERSION,
		senderId: args.senderId,
		deliveredAt,
	};
	try {
		await runtime.setCache(
			continuityAnchorCacheKey(runtime.agentId, args.roomId),
			anchor,
		);
	} catch (error) {
		// error-policy:J7 best-effort write — delivery already succeeded; missing
		// continuity only keeps on_mention strict (fail closed on the next turn).
		runtime.reportError("ReplyGateContinuity.record", error, {
			roomId: args.roomId,
			senderId: args.senderId,
		});
	}
}

/**
 * True when this inbound sender still holds the room's fresh delivered-engagement
 * anchor. `now` is the authoritative processing clock (defaults to Date.now());
 * event timestamps on the inbound message are never trusted for the TTL.
 */
export async function senderInActiveConversation(
	runtime: Pick<IAgentRuntime, "agentId" | "getCache" | "reportError">,
	message: Pick<Memory, "entityId" | "roomId">,
	now: number = Date.now(),
): Promise<boolean> {
	if (!message.entityId || !message.roomId) return false;
	if (message.entityId === runtime.agentId) return false;
	if (typeof now !== "number" || !Number.isFinite(now)) return false;

	let raw: unknown;
	try {
		raw = await runtime.getCache<OnMentionContinuityAnchor>(
			continuityAnchorCacheKey(runtime.agentId, message.roomId),
		);
	} catch (error) {
		// error-policy:J4 continuity is an optional relaxation of the reply
		// gate; on lookup failure the gate keeps its strict on_mention
		// behavior (fail closed) and the failure surfaces via RECENT_ERRORS.
		runtime.reportError("ReplyGateContinuity.history", error, {
			roomId: message.roomId,
		});
		return false;
	}

	if (!isContinuityAnchor(raw)) return false;
	if (raw.senderId !== message.entityId) return false;
	const age = now - raw.deliveredAt;
	// Reject negative ages (out-of-order / delayed historical events) and
	// anything outside the continuity window.
	if (!(age >= 0 && age <= CONTINUITY_WINDOW_MS)) return false;
	return true;
}
