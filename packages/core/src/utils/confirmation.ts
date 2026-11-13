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

/** A reply that opens with one of these words or phrases is a yes. */
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
/**
 * Yes words that are also everyday acknowledgements. Followed by a thank-you
 * ("okay thanks", "sure, thank you") they acknowledge the prompt rather than
 * approve it.
 */
const ACKNOWLEDGING_WORDS = new Set(["ok", "okay", "sure"]);
const THANKS_WORDS = new Set(["thanks", "thank", "thx", "ty", "cheers"]);
/** One of these anywhere in a reply makes it a no. */
const NEGATIVE_WORDS = new Set([
	"no",
	"n",
	"nope",
	"nah",
	"not",
	"never",
	"nevermind",
	"nvm",
	"negative",
	"don't",
	"dont",
	"cancel",
	"abort",
	"stop",
	"wait",
	"non",
	"pas",
	"nein",
	"nicht",
	"いいえ",
	"不",
	"不要",
	"取消",
	"아니",
	"아니요",
	"아뇨",
	"마",
	"마요",
	"마세요",
	"말아",
	"말아요",
	"말고",
]);

/**
 * Chinese and Japanese put no space between words, so a no word there sits
 * inside a longer run of text ("确认，先不要" is "确认" and "先不要").
 */
const UNSPACED_SCRIPT =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const UNSPACED_NEGATIVE_WORDS = [...NEGATIVE_WORDS].filter((word) =>
	UNSPACED_SCRIPT.test(word),
);

/**
 * Korean joins an ending to its word stem ("취소할게요" is "취소" and
 * "할게요"), and often writes 안 and 못 ("not") joined to the verb
 * ("안해요", "못하겠어요"). A Korean word that starts with one of these
 * stems is a no. 안녕 ("hello") also starts with 안, so it is not a no.
 */
const KOREAN_NEGATIVE_STEMS = ["아니", "않", "안", "못", "취소", "그만"];
// These ordinary compound words are not refusals. Keep their noun particles with the
// compound, without exempting other words that start with a no stem.
const KOREAN_NONNEGATIVE_COMPOUND =
	/^(?:그만큼(?:만|은|의)?|취소선(?:[은는이가을를도만]|으로|로)?)$/u;
/** A verb that ends in "-지 마", "-지 말", "-지 않" or "-지 못" ("하지마"). */
const KOREAN_NEGATED_VERB = /지[마말않못]/u;

function isKoreanNegativeWord(word: string): boolean {
	return (
		(KOREAN_NEGATIVE_STEMS.some((stem) => word.startsWith(stem)) &&
			!word.startsWith("안녕") &&
			!KOREAN_NONNEGATIVE_COMPOUND.test(word)) ||
		KOREAN_NEGATED_VERB.test(word)
	);
}

function isNegativeWord(word: string): boolean {
	return (
		NEGATIVE_WORDS.has(word) ||
		(UNSPACED_SCRIPT.test(word) &&
			UNSPACED_NEGATIVE_WORDS.some((negative) => word.includes(negative))) ||
		isKoreanNegativeWord(word)
	);
}

/** A thumbs-down or cross mark in a reply makes it a no too. */
const NEGATIVE_SYMBOLS = /[\u{1F44E}\u274C\u274E\u{1F6AB}\u2716]/u;

type ConfirmationReply = "affirmative" | "negative" | "unclear";

/**
 * Read the user's reply to a confirmation prompt. A reply that opens with a
 * yes ("yes", "ok, go ahead", "sí, por favor", "yes, delete it") is
 * affirmative. A reply with a no word anywhere ("ok, never mind", "yes, but
 * not Ann") is negative. Everything else, such as a question ("y?", "yes,
 * which one?"), a reply that does not open with a yes ("please delete Ann")
 * or an acknowledgement ("okay thanks"), is unclear, and the caller asks
 * again.
 */
function classifyConfirmationReply(message: Memory): ConfirmationReply {
	const text = readUserText(message)
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\u2019/g, "'");
	const words = (text.match(/[\p{L}\p{N}']+/gu) ?? [])
		.map((word) => word.replace(/^'+|'+$/g, ""))
		.filter(Boolean);
	if (NEGATIVE_SYMBOLS.test(text) || words.some(isNegativeWord))
		return "negative";
	if (/[?？¿]/u.test(text)) return "unclear";
	// Skip leading politeness ("please, yes"), then require a yes.
	let i = 0;
	while (i < words.length) {
		if (FILLER_PHRASES.has(`${words[i]} ${words[i + 1]}`)) i += 2;
		else if (FILLER_WORDS.has(words[i])) i++;
		else break;
	}
	const opensWithYes =
		AFFIRMATIVE_PHRASES.has(`${words[i]} ${words[i + 1]}`) ||
		AFFIRMATIVE_WORDS.has(words[i]);
	if (!opensWithYes) return "unclear";
	// "okay thanks" acknowledges the prompt unless a firmer yes is also there.
	const thanked = words.some((word) => THANKS_WORDS.has(word));
	const firmYes = words.some(
		(word, j) =>
			(AFFIRMATIVE_WORDS.has(word) && !ACKNOWLEDGING_WORDS.has(word)) ||
			AFFIRMATIVE_PHRASES.has(`${word} ${words[j + 1]}`),
	);
	if (thanked && !firmYes) return "unclear";
	return "affirmative";
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

	// No live record, or an unclear reply: (re)ask. A re-ask keeps the live
	// record's metadata when the caller passes none, so a caller that stashes
	// metadata only on the first ask still gets it back on the confirm.
	const live =
		existing && Date.now() - existing.createdAt <= existing.ttlMs
			? existing
			: undefined;
	const record: PendingConfirmation = {
		actionName: args.actionName,
		pendingKey: args.pendingKey,
		prompt: args.prompt,
		createdAt: Date.now(),
		ttlMs,
		metadata: args.metadata ?? live?.metadata,
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
