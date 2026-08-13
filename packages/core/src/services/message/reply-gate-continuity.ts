/**
 * Runtime-local continuity for the personality reply gate's on_mention mode.
 * A room opens only from a connector's transcript-visible delivery receipt,
 * never from response intent or transcript inference. State is weakly owned by
 * the runtime, expires after five minutes, and is capped per runtime.
 */
import type { Memory } from "../../types/memory";
import type { Content, UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";

/** Follow-ups older than this are a new approach, not a continuation. */
export const CONTINUITY_WINDOW_MS = 5 * 60_000;

/** Bounds per-runtime room state independently of room churn. */
export const MAX_CONTINUITY_ANCHORS_PER_RUNTIME = 256;

export type OnMentionContinuityAnchor = {
	/** Null marks equal-time receipts for different senders as ambiguous. */
	senderId: UUID | null;
	/** Maximum finite createdAt from the connector's matching delivery receipt. */
	deliveredAt: number;
};

type ContinuityRuntimeState = {
	anchors: Map<UUID, OnMentionContinuityAnchor>;
	pendingDeliveries: Map<UUID, Set<Promise<void>>>;
};

const continuityStates = new WeakMap<object, ContinuityRuntimeState>();

function getContinuityState(
	runtime: object,
	create: boolean,
): ContinuityRuntimeState | undefined {
	const existing = continuityStates.get(runtime);
	if (existing || !create) return existing;
	const created: ContinuityRuntimeState = {
		anchors: new Map(),
		pendingDeliveries: new Map(),
	};
	continuityStates.set(runtime, created);
	return created;
}

function sweepExpiredAnchors(state: ContinuityRuntimeState, now: number): void {
	for (const [roomId, anchor] of state.anchors) {
		const age = now - anchor.deliveredAt;
		if (!(age >= 0 && age <= CONTINUITY_WINDOW_MS)) {
			state.anchors.delete(roomId);
		}
	}
}

function evictOldestAnchor(state: ContinuityRuntimeState): void {
	let oldest: { roomId: UUID; deliveredAt: number } | undefined;
	for (const [roomId, anchor] of state.anchors) {
		if (
			!oldest ||
			anchor.deliveredAt < oldest.deliveredAt ||
			(anchor.deliveredAt === oldest.deliveredAt && roomId < oldest.roomId)
		) {
			oldest = { roomId, deliveredAt: anchor.deliveredAt };
		}
	}
	if (oldest) state.anchors.delete(oldest.roomId);
}

/**
 * Register a candidate delivery before calling the connector. An immediate
 * same-room follow-up waits until the connector either returns its receipt or
 * rejects; release is idempotent and removes the transient room allocation.
 */
export function registerOnMentionContinuityDeliveryBarrier(
	runtime: Pick<IAgentRuntime, "agentId">,
	roomId: UUID,
): () => void {
	const state = getContinuityState(runtime, true);
	if (!state) return () => undefined;
	let barriers = state.pendingDeliveries.get(roomId);
	if (!barriers) {
		barriers = new Set();
		state.pendingDeliveries.set(roomId, barriers);
	}
	let resolveBarrier: (() => void) | undefined;
	const barrier = new Promise<void>((resolve) => {
		resolveBarrier = resolve;
	});
	barriers.add(barrier);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		barriers?.delete(barrier);
		if (barriers?.size === 0) {
			state.pendingDeliveries.delete(roomId);
		}
		resolveBarrier?.();
	};
}

/**
 * True for transcript-visible dialogue. Internal rows, action-result
 * bookkeeping, blank text, and pure IGNORE/STOP terminal rows do not engage a
 * sender even if a connector returns them in its receipt array.
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
		? content.actions.map((action) => String(action).toUpperCase())
		: [];
	const hasTerminal = actions.some(
		(action) => action === "IGNORE" || action === "STOP",
	);
	const hasReply = actions.some((action) => action === "REPLY");
	return !hasTerminal || hasReply;
}

function latestTrustedDeliveryTimestamp(
	runtime: Pick<IAgentRuntime, "agentId">,
	roomId: UUID,
	delivered: unknown,
): number | undefined {
	if (!Array.isArray(delivered) || delivered.length === 0) return undefined;
	let latest: number | undefined;
	for (const candidate of delivered) {
		if (!candidate || typeof candidate !== "object") continue;
		const receipt = candidate as Partial<Memory>;
		if (
			receipt.agentId !== runtime.agentId ||
			receipt.entityId !== runtime.agentId ||
			receipt.roomId !== roomId ||
			typeof receipt.createdAt !== "number" ||
			!Number.isFinite(receipt.createdAt) ||
			!isTranscriptVisibleEngagement(receipt.content)
		) {
			continue;
		}
		latest =
			latest === undefined
				? receipt.createdAt
				: Math.max(latest, receipt.createdAt);
	}
	return latest;
}

/**
 * Record a connector-confirmed delivery for this inbound sender. Timestamp
 * ordering, rather than callback completion order, owns the room: older
 * receipts cannot overwrite newer ones, while equal timestamps from different
 * senders invalidate the room until a strictly newer receipt arrives.
 */
export function recordOnMentionContinuityDelivery(
	runtime: Pick<IAgentRuntime, "agentId">,
	args: {
		roomId: UUID;
		senderId: UUID;
		delivered: unknown;
	},
): void {
	if (!args.roomId || !args.senderId || args.senderId === runtime.agentId)
		return;
	const deliveredAt = latestTrustedDeliveryTimestamp(
		runtime,
		args.roomId,
		args.delivered,
	);
	if (deliveredAt === undefined) return;

	const state = getContinuityState(runtime, true);
	if (!state) return;
	sweepExpiredAnchors(state, Date.now());
	const current = state.anchors.get(args.roomId);
	if (current) {
		if (deliveredAt < current.deliveredAt) return;
		if (deliveredAt === current.deliveredAt) {
			if (current.senderId !== args.senderId) {
				state.anchors.set(args.roomId, { senderId: null, deliveredAt });
			}
			return;
		}
	}
	if (!current && state.anchors.size >= MAX_CONTINUITY_ANCHORS_PER_RUNTIME) {
		evictOldestAnchor(state);
	}
	state.anchors.set(args.roomId, { senderId: args.senderId, deliveredAt });
}

/**
 * True when this inbound sender still owns the room's fresh, unambiguous
 * delivery receipt. `now` exists for deterministic callers; event timestamps
 * on the inbound message are deliberately ignored.
 */
export async function senderInActiveConversation(
	runtime: Pick<IAgentRuntime, "agentId">,
	message: Pick<Memory, "entityId" | "roomId">,
	now?: number,
): Promise<boolean> {
	if (!message.entityId || !message.roomId) return false;
	if (message.entityId === runtime.agentId) return false;
	if (now !== undefined && !Number.isFinite(now)) return false;
	const state = getContinuityState(runtime, false);
	if (!state) return false;

	const pending = state.pendingDeliveries.get(message.roomId);
	if (pending?.size) await Promise.all([...pending]);
	const checkedAt = now ?? Date.now();
	sweepExpiredAnchors(state, checkedAt);
	const anchor = state.anchors.get(message.roomId);
	return anchor?.senderId === message.entityId;
}
