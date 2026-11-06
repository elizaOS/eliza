/**
 * Unified confirmation helper for destructive actions.
 *
 * Destructive actions (delete X, clear Y, uninstall Z, send public post,
 * sign transaction, etc.) should not fire on the first invocation.
 * Instead they should:
 * 1. Stash a pending-confirmation record in the runtime cache.
 * 2. Emit a callback message describing the operation and asking the
 * user to confirm.
 * 3. On a later turn in the same room, if the user's reply is a plain
 * "yes", proceed; if it says no, cancel; anything else asks again.
 *
 * This module centralizes that pattern so every destructive action
 * follows the same UX, the same TTL behavior, and the same cancel
 * semantics.
 *
 * Usage:
 * const decision = await requireConfirmation({
 * runtime,
 * message,
 * actionName: "DELETE_LINEAR_ISSUE",
 * pendingKey: `delete:${issueId}`,
 * prompt: `Permanently delete issue ${humanId}? This cannot be undone.`,
 * callback,
 * });
 * if (decision.status === "pending") {
 * return { success: true, data: { awaitingUserInput: true } };
 * }
 * if (decision.status === "cancelled") {
 * return { success: true, text: "Cancelled." };
 * }
 * // status === "confirmed" — proceed with the destructive op
 */

import { unwrapUserMessageText } from "../security/incoming-message-security";
import type { HandlerCallback } from "../types/components";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";

const DEFAULT_TTL_MS = 5 * 60_000;

/** A reply made only of these words and phrases (and fillers) is a yes. */
const AFFIRMATIVE_WORDS = new Set([
	"yes",
	"yeah",
	"yep",
	"y",
	"ok",
	"okay",
	"sure",
	"confirm",
	"confirmed",
	"proceed",
	"approve",
	"approved",
	"si",
	"sí",
	"oui",
	"ja",
	"hai",
	"はい",
	"确认",
	"確認",
	"확인",
]);
const AFFIRMATIVE_PHRASES = new Set(["do it", "go ahead"]);
/** Politeness that may accompany a yes but is not one by itself. */
const FILLER_WORDS = new Set(["please"]);
const FILLER_PHRASES = new Set(["por favor"]);
/** One of these anywhere in a reply makes it a no. */
const NEGATIVE_WORDS = new Set([
	"no",
	"nope",
	"nah",
	"not",
	"never",
	"nevermind",
	"don't",
	"dont",
	"cancel",
	"stop",
	"wait",
	"non",
	"nein",
	"いいえ",
	"不",
	"不要",
	"取消",
	"아니",
	"아니요",
]);

type ConfirmationReply = "affirmative" | "negative" | "unclear";

/**
 * Read the user's reply to a confirmation prompt. A reply made entirely of
 * yes words ("yes", "ok, go ahead", "sí, por favor") is affirmative. A reply
 * with a no word anywhere ("ok, never mind", "yes, but not Ann") is negative.
 * Everything else, such as a question ("y?") or an acknowledgement ("okay
 * thanks"), is unclear, and the caller asks again.
 */
function classifyConfirmationReply(message: Memory): ConfirmationReply {
	const text = readUserText(message)
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\u2019/g, "'");
	const words = (text.match(/[\p{L}\p{N}']+/gu) ?? [])
		.map((word) => word.replace(/^'+|'+$/g, ""))
		.filter(Boolean);
	if (words.some((word) => NEGATIVE_WORDS.has(word))) return "negative";
	if (/[?？¿]/u.test(text)) return "unclear";
	let affirmed = false;
	for (let i = 0; i < words.length; i++) {
		const pair = `${words[i]} ${words[i + 1]}`;
		if (AFFIRMATIVE_PHRASES.has(pair) || FILLER_PHRASES.has(pair)) {
			affirmed ||= AFFIRMATIVE_PHRASES.has(pair);
			i++;
		} else if (AFFIRMATIVE_WORDS.has(words[i])) {
			affirmed = true;
		} else if (!FILLER_WORDS.has(words[i])) {
			return "unclear";
		}
	}
	return affirmed ? "affirmative" : "unclear";
}

export type ConfirmationStatus = "pending" | "confirmed" | "cancelled";

interface PendingConfirmation {
	readonly actionName: string;
	readonly pendingKey: string;
	readonly prompt: string;
	readonly createdAt: number;
	readonly ttlMs: number;
	readonly metadata?: Record<string, unknown>;
	/**
	 * Id of the user message that asked for the operation. Only a LATER
	 * message may confirm or cancel: a planner can run the same action twice
	 * inside one turn with the same message, and that message must not count
	 * as the owner's reply to the prompt it triggered.
	 */
	readonly requestMessageId?: string;
}

export interface RequireConfirmationArgs {
	runtime: IAgentRuntime;
	message: Memory;
	/** Action name doing the destructive op. Used in the cache key + emitted prompt. */
	actionName: string;
	/**
	 * Stable key identifying the specific pending operation, e.g.
	 * `delete:${issueId}`. Combined with the room, user id and action name to
	 * form the cache key, so only a reply in the room that showed the prompt
	 * can settle it. Two simultaneous pending confirmations with the same
	 * pendingKey for the same user in one room are not supported.
	 */
	pendingKey: string;
	/** Human-readable prompt the user sees. */
	prompt: string;
	/** Optional callback for emitting the prompt; if omitted, the
	 * caller is expected to deliver `prompt` via its own mechanism. */
	callback?: HandlerCallback;
	/** TTL for the pending record. Default 5 minutes. */
	ttlMs?: number;
	/** Optional structured metadata to stash on the pending record (passed back on confirm). */
	metadata?: Record<string, unknown>;
}

export interface ConfirmationDecision {
	status: ConfirmationStatus;
	/** When status is "confirmed" or "cancelled", this is the metadata
	 * that was stashed when the confirmation was first requested. */
	metadata?: Record<string, unknown>;
}

function buildCacheKey(
	roomId: string,
	userId: string,
	actionName: string,
	pendingKey: string,
): string {
	return `confirmation:${roomId}:${userId}:${actionName}:${pendingKey}`;
}

function readUserText(message: Memory): string {
	return unwrapUserMessageText(message);
}

/**
 * True when the user's own message is a plain yes, read the same way as
 * {@link requireConfirmation}. Callers that persist their pending preview
 * durably (instead of in the runtime cache) use this so the decision is still
 * bound to the actual user reply, never to model output.
 */
export function isAffirmativeConfirmationReply(message: Memory): boolean {
	return classifyConfirmationReply(message) === "affirmative";
}

/**
 * Two-phase destructive-action helper.
 *
 * Returns:
 * - `{ status: "pending" }` on the FIRST invocation (no record for this room
 * yet), and on a later one whose reply is neither a plain yes nor a no. The
 * helper has stashed the record and (if `callback` is provided) emitted the
 * prompt again. Caller should return early without performing the op.
 *
 * - `{ status: "confirmed", metadata }` on a later invocation in the same room
 * when the user replied with a plain yes. The pending record has been
 * cleared. Caller should perform the destructive op.
 *
 * - `{ status: "cancelled", metadata }` on a later invocation in the same room
 * when the reply says no. The pending record has been cleared. Caller should
 * not perform the op.
 *
 * Expired pending records (older than ttlMs) are treated as fresh first calls.
 */
export async function requireConfirmation(
	args: RequireConfirmationArgs,
): Promise<ConfirmationDecision> {
	const ttlMs =
		typeof args.ttlMs === "number" &&
		Number.isFinite(args.ttlMs) &&
		args.ttlMs > 0
			? args.ttlMs
			: DEFAULT_TTL_MS;
	const cacheKey = buildCacheKey(
		String(args.message.roomId),
		String(args.message.entityId),
		args.actionName,
		args.pendingKey,
	);

	const existing = await args.runtime.getCache<PendingConfirmation>(cacheKey);
	if (existing && Date.now() - existing.createdAt <= existing.ttlMs) {
		// The message that asked for the operation is not a reply to its
		// prompt: keep waiting for the next user message.
		const sameMessage =
			existing.requestMessageId !== undefined &&
			args.message.id !== undefined &&
			String(args.message.id) === existing.requestMessageId;
		if (sameMessage) {
			return { status: "pending" };
		}
		const reply = classifyConfirmationReply(args.message);
		if (reply !== "unclear") {
			await args.runtime.deleteCache(cacheKey);
			return {
				status: reply === "affirmative" ? "confirmed" : "cancelled",
				metadata: existing.metadata,
			};
		}
	}

	// No live record, or an unclear reply: (re)ask.
	const record: PendingConfirmation = {
		actionName: args.actionName,
		pendingKey: args.pendingKey,
		prompt: args.prompt,
		createdAt: Date.now(),
		ttlMs,
		metadata: args.metadata,
		...(args.message.id ? { requestMessageId: String(args.message.id) } : {}),
	};
	await args.runtime.setCache(cacheKey, record);
	if (args.callback) {
		await args.callback({
			text: args.prompt,
			source: args.message.content.source,
		});
	}
	return { status: "pending" };
}

/**
 * Clear a pending confirmation without resolving it. Useful for callers
 * that want to abandon a prior pending op (e.g. when a different action
 * supersedes the one awaiting confirmation).
 */
export async function clearPendingConfirmation(args: {
	runtime: IAgentRuntime;
	roomId: string;
	userId: string;
	actionName: string;
	pendingKey: string;
}): Promise<void> {
	const cacheKey = buildCacheKey(
		args.roomId,
		args.userId,
		args.actionName,
		args.pendingKey,
	);
	await args.runtime.deleteCache(cacheKey);
}

export type DestructiveConfirmationGateResult =
	| {
			readonly status: "confirmed";
			readonly metadata?: Record<string, unknown>;
	  }
	| { readonly status: "pending" }
	| {
			readonly status: "cancelled";
			readonly metadata?: Record<string, unknown>;
	  };

/**
 * Thin wrapper around {@link requireConfirmation} for destructive action handlers.
 * Never consult LLM `confirmed` params — only user yes/no on a follow-up turn.
 */
export async function gateDestructiveConfirmation(
	args: RequireConfirmationArgs,
): Promise<DestructiveConfirmationGateResult> {
	const decision = await requireConfirmation(args);
	if (decision.status === "confirmed") {
		return { status: "confirmed", metadata: decision.metadata };
	}
	if (decision.status === "pending") {
		return { status: "pending" };
	}
	return { status: "cancelled", metadata: decision.metadata };
}

/** LLM `confirmed: true` must not authorize destructive ops (GHSA-rqm7 class). */
export function llmConfirmedFlagIsAuthoritative(_value: unknown): boolean {
	return false;
}
