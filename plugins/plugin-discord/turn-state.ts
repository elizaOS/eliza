/**
 * Durable turn / outbox state machine for Discord inbound replies.
 *
 * Motivation (SOLIZA cutover charter rows D4/D5): PR #16696 makes an
 * already-persisted inbound Discord message suppress a second model turn on
 * redelivery. That closes the double-dispatch window but opens a worse one: a
 * crash AFTER inbound memory persistence but BEFORE the outbound reply leaves
 * the turn permanently suppressed on replay, so no reply is ever sent.
 *
 * This module records a durable turn record keyed by the Discord message id and
 * drives it through an explicit lifecycle so a resumed process can tell the
 * difference between "already replied" (no-op) and "persisted but never
 * replied" (resume the reply path with bounded retries, then terminal FAILED).
 *
 * Delivery model: SEND-THEN-RECORD with a durable reply-memory probe.
 *
 *   Why send-then-record rather than record-then-send? The Discord connector
 *   already writes a durable outbound *reply memory* for every message it
 *   emits, stamped with `content.inReplyTo = <inbound message id>` and
 *   `metadata.platformMessageId = <discord reply id>` (see the response
 *   callback in messages.ts). That reply memory IS the authoritative
 *   record-of-send. Introducing a separate "reserved-before-send" outbox row
 *   would create a second source of truth that can itself desync from Discord
 *   on a crash between reserve and send. Instead we reconcile against the
 *   reply-memory that the send path already produces:
 *
 *     - Before (re)dispatching a resumed turn, probe for an existing reply
 *       memory in the room whose `inReplyTo` matches this inbound. If one
 *       exists, the reply already went out (a crash happened AFTER send but
 *       BEFORE we could stamp the turn REPLIED); we reconcile the turn to
 *       REPLIED and DO NOT send again. This is the "reconcile check" that makes
 *       send-then-record safe against a crash in the send<->record gap.
 *     - Only if no reply memory exists do we resume dispatch. The generation
 *       and send path is idempotent-on-content via #15601's outbound reservation
 *       and #13054's outbound memory dedupe, so a bounded retry cannot fan out.
 *
 * The turn record is stored as an ordinary memory in a dedicated table so it
 * inherits the same durability, restart survival, and (optional) retention as
 * the rest of the store, with no schema migration.
 */

import {
	createUniqueUuid,
	type IAgentRuntime,
	type Memory,
	type UUID,
} from "@elizaos/core";

/** Table that holds durable Discord turn records. */
export const DISCORD_TURN_TABLE = "discord_turns";

/** Default bound on reply retries before a turn is marked terminal FAILED. */
export const DISCORD_TURN_MAX_ATTEMPTS = 3;

export type DiscordTurnState = "RECEIVED" | "DISPATCHED" | "REPLIED" | "FAILED";

/** Terminal states never resume. */
export function isTerminalTurnState(state: DiscordTurnState): boolean {
	return state === "REPLIED" || state === "FAILED";
}

export interface DiscordTurnRecord {
	/** Deterministic UUID derived from the Discord message id. */
	id: UUID;
	/** Raw Discord message id (idempotency key). */
	platformMessageId: string;
	state: DiscordTurnState;
	/** Number of reply-dispatch attempts already made. */
	attempts: number;
	/** Discord message id of the persisted reply once REPLIED, if known. */
	replyMessageId?: string;
	/** Free-form terminal reason for FAILED. */
	failureReason?: string;
	createdAt: number;
	updatedAt: number;
}

/** Minimal runtime surface this module needs; keeps unit tests trivial. */
export type DiscordTurnRuntime = Pick<
	IAgentRuntime,
	"agentId" | "createMemory" | "getMemoryById" | "getMemories"
>;

/** Deterministic turn id from the Discord message id. */
export function discordTurnId(
	runtime: Pick<IAgentRuntime, "agentId">,
	platformMessageId: string,
): UUID {
	return createUniqueUuid(runtime, `discord-turn:${platformMessageId}`) as UUID;
}

function decodeTurnRecord(memory: Memory): DiscordTurnRecord | null {
	const data = (memory.content?.data ?? {}) as Partial<DiscordTurnRecord> & {
		platformMessageId?: string;
		state?: DiscordTurnState;
	};
	if (!memory.id || !data.platformMessageId || !data.state) {
		return null;
	}
	return {
		id: memory.id,
		platformMessageId: data.platformMessageId,
		state: data.state,
		attempts: typeof data.attempts === "number" ? data.attempts : 0,
		replyMessageId: data.replyMessageId,
		failureReason: data.failureReason,
		createdAt:
			typeof data.createdAt === "number"
				? data.createdAt
				: (memory.createdAt ?? Date.now()),
		updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
	};
}

function encodeTurnRecord(
	runtime: Pick<IAgentRuntime, "agentId">,
	record: DiscordTurnRecord,
): Memory {
	return {
		id: record.id,
		entityId: runtime.agentId,
		agentId: runtime.agentId,
		roomId: record.id,
		content: {
			text: `discord-turn ${record.platformMessageId} ${record.state}`,
			source: "discord-turn",
			data: {
				platformMessageId: record.platformMessageId,
				state: record.state,
				attempts: record.attempts,
				replyMessageId: record.replyMessageId,
				failureReason: record.failureReason,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			},
		},
		createdAt: record.createdAt,
	} as Memory;
}

/** Load an existing durable turn record, or null if none. */
export async function loadDiscordTurn(
	runtime: DiscordTurnRuntime,
	platformMessageId: string,
): Promise<DiscordTurnRecord | null> {
	const id = discordTurnId(runtime, platformMessageId);
	const existing = await runtime.getMemoryById(id);
	if (!existing) return null;
	return decodeTurnRecord(existing);
}

/**
 * Persist (upsert) a turn record. `createMemory` on our store is an upsert by
 * id (unique row), so the same call both claims and advances the record.
 */
async function writeDiscordTurn(
	runtime: DiscordTurnRuntime,
	record: DiscordTurnRecord,
): Promise<DiscordTurnRecord> {
	const stamped: DiscordTurnRecord = { ...record, updatedAt: Date.now() };
	await runtime.createMemory(
		encodeTurnRecord(runtime, stamped),
		DISCORD_TURN_TABLE,
		true,
	);
	return stamped;
}

/**
 * Claim a turn at inbound. Returns the durable record and whether this call
 * created it. If the record already exists this is a resume/redelivery: the
 * caller inspects `record.state` to decide no-op (terminal) vs resume.
 */
export async function claimDiscordTurn(
	runtime: DiscordTurnRuntime,
	platformMessageId: string,
): Promise<{ record: DiscordTurnRecord; created: boolean }> {
	const existing = await loadDiscordTurn(runtime, platformMessageId);
	if (existing) {
		return { record: existing, created: false };
	}
	const now = Date.now();
	const record: DiscordTurnRecord = {
		id: discordTurnId(runtime, platformMessageId),
		platformMessageId,
		state: "RECEIVED",
		attempts: 0,
		createdAt: now,
		updatedAt: now,
	};
	const stored = await writeDiscordTurn(runtime, record);
	return { record: stored, created: true };
}

/** Advance a claimed turn to DISPATCHED and increment the attempt counter. */
export async function markDiscordTurnDispatched(
	runtime: DiscordTurnRuntime,
	record: DiscordTurnRecord,
): Promise<DiscordTurnRecord> {
	return writeDiscordTurn(runtime, {
		...record,
		state: "DISPATCHED",
		attempts: record.attempts + 1,
	});
}

/** Advance a turn to terminal REPLIED. */
export async function markDiscordTurnReplied(
	runtime: DiscordTurnRuntime,
	record: DiscordTurnRecord,
	replyMessageId?: string,
): Promise<DiscordTurnRecord> {
	return writeDiscordTurn(runtime, {
		...record,
		state: "REPLIED",
		replyMessageId: replyMessageId ?? record.replyMessageId,
	});
}

/** Advance a turn to terminal FAILED with a reason (no silent drop). */
export async function markDiscordTurnFailed(
	runtime: DiscordTurnRuntime,
	record: DiscordTurnRecord,
	failureReason: string,
): Promise<DiscordTurnRecord> {
	return writeDiscordTurn(runtime, {
		...record,
		state: "FAILED",
		failureReason,
	});
}

/**
 * Reconcile probe (the send-then-record safety check). Look for a durable
 * outbound reply memory in the same room that references this inbound message.
 * The connector stamps `content.inReplyTo = <inbound message id>` on every
 * reply memory, so its presence proves the reply already left the process even
 * if the turn record never reached REPLIED (crash in the send<->record gap).
 *
 * Returns the discord reply id when a reply is found, else null.
 */
export async function findDeliveredReply(
	runtime: DiscordTurnRuntime,
	roomId: UUID,
	inboundMemoryId: UUID,
): Promise<string | null> {
	let memories: Memory[];
	try {
		memories = await runtime.getMemories({
			roomId,
			tableName: "messages",
			agentId: runtime.agentId,
			count: 50,
		});
	} catch {
		// Probe failure is treated as "unknown / not found": we would rather
		// risk a bounded content-idempotent retry than skip a reply entirely.
		return null;
	}
	for (const m of memories) {
		if (m.entityId !== runtime.agentId) continue;
		if (m.content?.inReplyTo !== inboundMemoryId) continue;
		const platformMessageId = m.metadata?.platformMessageId;
		return typeof platformMessageId === "string" ? platformMessageId : "";
	}
	return null;
}

export type DiscordTurnResumeDecision =
	| { action: "noop"; reason: "replied" | "failed" }
	| { action: "reconciled-replied"; replyMessageId: string }
	| { action: "resume"; record: DiscordTurnRecord }
	| { action: "exhausted"; record: DiscordTurnRecord };

/**
 * Decide what to do with a turn that already has a durable record (i.e. the
 * inbound was persisted on a prior delivery). Pure decision function: it does
 * not send or mutate. The caller executes the returned action.
 *
 *   - terminal REPLIED / FAILED  -> noop
 *   - a reply memory already exists -> reconciled-replied (record advances to
 *     REPLIED, NO resend)
 *   - attempts already at/over the bound -> exhausted (caller marks FAILED)
 *   - otherwise -> resume (caller dispatches the reply path)
 */
export function decideResume(
	record: DiscordTurnRecord,
	deliveredReplyId: string | null,
	maxAttempts: number = DISCORD_TURN_MAX_ATTEMPTS,
): DiscordTurnResumeDecision {
	if (record.state === "REPLIED") {
		return { action: "noop", reason: "replied" };
	}
	if (record.state === "FAILED") {
		return { action: "noop", reason: "failed" };
	}
	if (deliveredReplyId !== null) {
		return { action: "reconciled-replied", replyMessageId: deliveredReplyId };
	}
	if (record.attempts >= maxAttempts) {
		return { action: "exhausted", record };
	}
	return { action: "resume", record };
}
