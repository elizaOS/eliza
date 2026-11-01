/**
 * Unified confirmation helper for destructive actions.
 *
 * Destructive actions (delete X, clear Y, uninstall Z, send public post,
 * sign transaction, etc.) should not fire on the first invocation.
 * Instead they should:
 * 1. Stash a pending-confirmation record in the runtime cache.
 * 2. Emit a callback message describing the operation and asking the
 * user to confirm.
 * 3. On the next turn, if the user message reads as "yes", proceed;
 * otherwise cancel.
 *
 * This module centralizes that pattern so every destructive action
 * follows the same UX, the same TTL behavior, and the same cancel
 * semantics.
 *
 * A cancel has no sentence for the user. `requireConfirmation` returns
 * `{ status: "cancelled" }` and does not call `callback`. The caller owns
 * the words the user sees. Callers in this repository use their own text,
 * such as "Cancelled.", "Wallet operation cancelled.", or "Unsubscribe
 * cancelled." None of those sentences tell the user to reply with just
 * "yes". A caller that wants that hint must put it in its own cancel
 * sentence. A later message that is only "yes" does not run the cleared
 * action. The next call returns pending and shows the prompt again.
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
 * // The helper returns no sentence. The caller chooses the text.
 * return { success: true, text: "Cancelled." };
 * }
 * // status === "confirmed" — proceed with the destructive op
 */

import { unwrapUserMessageText } from "../security/incoming-message-security";
import type { HandlerCallback } from "../types/components";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";

const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Whole-reply yes words. A destructive confirmation used to accept any message
 * that started with one of these words, so "yes, but don't" and "go ahead and
 * delete the rest" ran the operation. The reply must be only the yes word.
 * One optional "please", one opening quote or bracket, and trailing punctuation
 * other than a question mark are still a yes. Anything else cancels.
 * "Yes, delete it" and "yes 👍" cancel. The extra words stay in the reply.
 * The emoji is a symbol, so it is not stripped with the punctuation.
 * Consumers can pass a custom `confirmRegex` for a different contract.
 */
const AFFIRMATIVE_REPLY =
	/^(?:yes please|yes|yeah|yep|y|okay please|okay|ok please|ok|sure|confirmed|confirm|do it|go ahead|proceed|approved|approve|sí|si|oui|ja|hai|はい|确认|確認|확인)$/u;
const OPENING_QUOTE_OR_BRACKET = /^[\p{Pi}\p{Ps}]/u;
const QUESTION_MARK = /^[?¿？]$/u;
const TRAILING_CLOSER = /^[\p{Pe}\p{Pf}\p{Po}]$/u;

function lastCodePoint(value: string): { char: string; rest: string } | null {
	if (value.length === 0) return null;
	let start = value.length - 1;
	const tail = value.charCodeAt(start);
	if (tail >= 0xdc00 && tail <= 0xdfff && start > 0) {
		const head = value.charCodeAt(start - 1);
		if (head >= 0xd800 && head <= 0xdbff) start -= 1;
	}
	return { char: value.slice(start), rest: value.slice(0, start) };
}

function isWholeAffirmativeReply(text: string): boolean {
	let value = text.trim();
	const opening = OPENING_QUOTE_OR_BRACKET.exec(value);
	if (opening?.[0]) {
		value = value.slice(opening[0].length).trimStart();
	}
	for (;;) {
		const last = lastCodePoint(value.trimEnd());
		if (!last || QUESTION_MARK.test(last.char)) break;
		if (!TRAILING_CLOSER.test(last.char)) break;
		value = last.rest;
	}
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/,\s*/g, " ")
		.replace(/ +/g, " ")
		.trim();
	return AFFIRMATIVE_REPLY.test(normalized);
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
	 * `delete:${issueId}`. Combined with the user id and action name to
	 * form the cache key. Two simultaneous pending confirmations with
	 * the same pendingKey for the same user are not supported.
	 */
	pendingKey: string;
	/** Human-readable prompt the user sees. */
	prompt: string;
	/** Optional callback for emitting the prompt; if omitted, the
	 * caller is expected to deliver `prompt` via its own mechanism. */
	callback?: HandlerCallback;
	/** TTL for the pending record. Default 5 minutes. */
	ttlMs?: number;
	/** Custom yes detector. */
	confirmRegex?: RegExp;
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
	userId: string,
	actionName: string,
	pendingKey: string,
): string {
	return `confirmation:${userId}:${actionName}:${pendingKey}`;
}

function readUserText(message: Memory): string {
	return unwrapUserMessageText(message);
}

/**
 * Classify the user's own message as an affirmative confirmation reply using
 * the same detector as {@link requireConfirmation}. Callers that persist their
 * pending preview durably (instead of in the runtime cache) use this so the
 * decision is still bound to the actual user reply, never to model output.
 */
export function isAffirmativeConfirmationReply(
	message: Memory,
	confirmRegex?: RegExp,
): boolean {
	const text = readUserText(message);
	if (confirmRegex) return confirmRegex.test(text);
	return isWholeAffirmativeReply(text);
}

/**
 * Two-phase destructive-action helper.
 *
 * Returns:
 * - `{ status: "pending" }` on the FIRST invocation (no record in cache yet).
 * The helper has stashed the record and (if `callback` is provided) emitted
 * the prompt. Caller should return early without performing the op.
 *
 * - `{ status: "confirmed", metadata }` on the SECOND invocation when the user
 * replied with a yes-shaped message. The pending record has been cleared.
 * Caller should perform the destructive op.
 *
 * - `{ status: "cancelled", metadata }` on the SECOND invocation when the user
 * replied with a no-shaped message OR anything not matching yes, including
 * "Yes, delete it" and "yes 👍". The pending record has been cleared. The
 * return value has no text, and `callback` is not called. The caller owns
 * the cancel sentence. Caller should not perform the op. A later reply that
 * is only "yes" starts a new preview. It does not run this cleared action.
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
	const userId = String(args.message.entityId);
	const cacheKey = buildCacheKey(userId, args.actionName, args.pendingKey);

	const existing = await args.runtime.getCache<PendingConfirmation>(cacheKey);
	const fresh = !existing || Date.now() - existing.createdAt > existing.ttlMs;

	if (fresh) {
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

	// The message that asked for the operation is not a reply to its prompt:
	// keep waiting for the next user message.
	const sameMessage =
		existing.requestMessageId !== undefined &&
		args.message.id !== undefined &&
		String(args.message.id) === existing.requestMessageId;
	if (sameMessage) {
		return { status: "pending" };
	}

	// Existing pending record found — interpret the user's reply.
	await args.runtime.deleteCache(cacheKey);

	const status: ConfirmationStatus = isAffirmativeConfirmationReply(
		args.message,
		args.confirmRegex,
	)
		? "confirmed"
		: "cancelled";
	return { status, metadata: existing.metadata };
}

/**
 * Clear a pending confirmation without resolving it. Useful for callers
 * that want to abandon a prior pending op (e.g. when a different action
 * supersedes the one awaiting confirmation).
 */
export async function clearPendingConfirmation(args: {
	runtime: IAgentRuntime;
	userId: string;
	actionName: string;
	pendingKey: string;
}): Promise<void> {
	const cacheKey = buildCacheKey(args.userId, args.actionName, args.pendingKey);
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
