/**
 * Active-conversation continuity for the personality reply-gate's on_mention
 * mode. Continuity is a typed per-room anchor written ONLY after a successfully
 * delivered, transcript-visible reply to a human sender — never inferred from
 * recent message history (IGNORE/STOP/action_result rows, rejected deliveries,
 * truncated windows, and untrusted event timestamps all make transcript
 * inference unsafe). Fails CLOSED (false) on cache read errors so a storage
 * hiccup can never relax the over-reply mitigation.
 */
import { ElizaError } from "../../errors";
import type { Memory } from "../../types/memory";
import type { Content, UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";

/** Follow-ups older than this are a new approach, not a continuation. */
export const CONTINUITY_WINDOW_MS = 5 * 60_000;

/** Cache schema version — bump if the stored shape changes. */
export const CONTINUITY_ANCHOR_VERSION = 1 as const;

// A connector can finish delivery while another same-room turn is already
// entering the reply gate. Keep the post-delivery cache write observable to
// that turn, and serialize same-room writes so slower storage cannot let an
// older delivery overwrite a newer engagement anchor.
const continuityWriteQueues = new WeakMap<object, Map<string, Promise<void>>>();
const continuityDeliveryBarriers = new WeakMap<
	object,
	Map<string, Set<Promise<void>>>
>();

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
 * Register the narrow interval in which a visible connector delivery can
 * succeed before its continuity anchor is persisted. The caller must release
 * the barrier after recording the successful delivery, or after rejection.
 */
export function registerOnMentionContinuityDeliveryBarrier(
	runtime: Pick<IAgentRuntime, "agentId">,
	roomId: UUID,
): () => void {
	const key = continuityAnchorCacheKey(runtime.agentId, roomId);
	let barriersByKey = continuityDeliveryBarriers.get(runtime);
	if (!barriersByKey) {
		barriersByKey = new Map();
		continuityDeliveryBarriers.set(runtime, barriersByKey);
	}
	let barriers = barriersByKey.get(key);
	if (!barriers) {
		barriers = new Set();
		barriersByKey.set(key, barriers);
	}
	let releasePromise: (() => void) | undefined;
	const barrier = new Promise<void>((resolve) => {
		releasePromise = resolve;
	});
	barriers.add(barrier);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		barriers?.delete(barrier);
		if (barriers?.size === 0) {
			barriersByKey?.delete(key);
		}
		releasePromise?.();
	};
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
	const key = continuityAnchorCacheKey(runtime.agentId, args.roomId);
	let queues = continuityWriteQueues.get(runtime);
	if (!queues) {
		queues = new Map();
		continuityWriteQueues.set(runtime, queues);
	}
	const previous = queues.get(key) ?? Promise.resolve();
	const write = previous
		.then(async () => {
			const stored = await runtime.setCache(key, anchor);
			if (!stored) {
				throw new ElizaError("Continuity anchor cache write was rejected", {
					code: "REPLY_GATE_CONTINUITY_WRITE_REJECTED",
					context: { roomId: args.roomId, senderId: args.senderId },
					severity: "ephemeral",
				});
			}
		})
		.catch((error) => {
			// error-policy:J7 delivery already succeeded; report the failed anchor
			// write and keep the next on_mention decision strict.
			runtime.reportError("ReplyGateContinuity.record", error, {
				roomId: args.roomId,
				senderId: args.senderId,
			});
		});
	queues.set(key, write);
	await write;
	if (queues.get(key) === write) {
		queues.delete(key);
	}
}

/**
 * True when this inbound sender still holds the room's fresh delivered-engagement
 * anchor. `now` is an optional authoritative processing clock for deterministic
 * callers; otherwise the clock is read after pending deliveries settle. Event
 * timestamps on the inbound message are never trusted for the TTL.
 */
export async function senderInActiveConversation(
	runtime: Pick<IAgentRuntime, "agentId" | "getCache" | "reportError">,
	message: Pick<Memory, "entityId" | "roomId">,
	now?: number,
): Promise<boolean> {
	if (!message.entityId || !message.roomId) return false;
	if (message.entityId === runtime.agentId) return false;
	if (now !== undefined && !Number.isFinite(now)) return false;
	const key = continuityAnchorCacheKey(runtime.agentId, message.roomId);

	let raw: unknown;
	try {
		const pendingDeliveries = continuityDeliveryBarriers.get(runtime)?.get(key);
		if (pendingDeliveries?.size) {
			await Promise.all([...pendingDeliveries]);
		}
		// A transport callback can make the reply visible before its cache write
		// settles. Wait for that narrow handoff so an immediate follow-up does not
		// get dropped between successful delivery and anchor persistence.
		await continuityWriteQueues.get(runtime)?.get(key);
		raw = await runtime.getCache<OnMentionContinuityAnchor>(key);
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
	const age = (now ?? Date.now()) - raw.deliveredAt;
	// Reject negative ages (out-of-order / delayed historical events) and
	// anything outside the continuity window.
	if (!(age >= 0 && age <= CONTINUITY_WINDOW_MS)) return false;
	return true;
}
