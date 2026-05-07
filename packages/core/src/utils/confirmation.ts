/**
 * Unified confirmation helper for destructive actions.
 *
 * Destructive actions (delete X, clear Y, uninstall Z, send public post,
 * sign transaction, etc.) should not fire on the first invocation.
 * Instead they should:
 *   1. Stash a pending-confirmation record in the runtime cache.
 *   2. Emit a callback message describing the operation and asking the
 *      user to confirm.
 *   3. On the next turn, if the user message reads as "yes", proceed;
 *      otherwise cancel.
 *
 * This module centralizes that pattern so every destructive action
 * follows the same UX, the same TTL behavior, and the same cancel
 * semantics.
 *
 * Usage:
 *   const decision = await requireConfirmation({
 *     runtime,
 *     message,
 *     actionName: "DELETE_LINEAR_ISSUE",
 *     pendingKey: `delete:${issueId}`,
 *     prompt: `Permanently delete issue ${humanId}? This cannot be undone.`,
 *     callback,
 *   });
 *   if (decision.status === "pending") {
 *     return { success: true, data: { awaitingUserInput: true } };
 *   }
 *   if (decision.status === "cancelled") {
 *     return { success: true, text: "Cancelled." };
 *   }
 *   // status === "confirmed" — proceed with the destructive op
 */

import type { HandlerCallback } from "../types/components";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";

const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Default broad multilingual yes detector. Consumers can pass a custom
 * `confirmRegex` if they want stricter or extended matching.
 */
const DEFAULT_CONFIRM_REGEX =
	/^\s*(yes|yeah|yep|y|ok|okay|sure|confirm|confirmed|do it|go ahead|proceed|approve|approved|si|sí|oui|ja|hai|はい|确认|확인)\b/i;

/**
 * Default broad cancel detector. Anything that doesn't match yes and DOES
 * match cancel is treated as an explicit cancel; anything else (random
 * unrelated reply) is treated as cancel-by-default to avoid silently
 * holding pending state.
 */
const DEFAULT_CANCEL_REGEX =
	/^\s*(no|nope|n|cancel|stop|abort|forget it|never mind|nevermind|nah|non|nein|否)\b/i;

export type ConfirmationStatus = "pending" | "confirmed" | "cancelled";

interface PendingConfirmation {
	readonly actionName: string;
	readonly pendingKey: string;
	readonly prompt: string;
	readonly createdAt: number;
	readonly ttlMs: number;
	readonly metadata?: Record<string, unknown>;
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
	/** Custom cancel detector. */
	cancelRegex?: RegExp;
	/** Optional structured metadata to stash on the pending record (passed back on confirm). */
	metadata?: Record<string, unknown>;
}

export interface ConfirmationDecision {
	status: ConfirmationStatus;
	/** When status is "confirmed" or "cancelled", this is the metadata
	 * that was stashed when the confirmation was first requested. */
	metadata?: Record<string, unknown>;
}

function buildCacheKey(userId: string, actionName: string, pendingKey: string): string {
	return `confirmation:${userId}:${actionName}:${pendingKey}`;
}

function readUserText(message: Memory): string {
	const text = message.content?.text;
	return typeof text === "string" ? text.trim() : "";
}

/**
 * Two-phase destructive-action helper.
 *
 * Returns:
 *   - `{ status: "pending" }` on the FIRST invocation (no record in cache yet).
 *     The helper has stashed the record and (if `callback` is provided) emitted
 *     the prompt. Caller should return early without performing the op.
 *
 *   - `{ status: "confirmed", metadata }` on the SECOND invocation when the user
 *     replied with a yes-shaped message. The pending record has been cleared.
 *     Caller should perform the destructive op.
 *
 *   - `{ status: "cancelled", metadata }` on the SECOND invocation when the user
 *     replied with a no-shaped message OR anything not matching yes. The pending
 *     record has been cleared. Caller should not perform the op.
 *
 * Expired pending records (older than ttlMs) are treated as fresh first calls.
 */
export async function requireConfirmation(
	args: RequireConfirmationArgs,
): Promise<ConfirmationDecision> {
	const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
	const confirmRegex = args.confirmRegex ?? DEFAULT_CONFIRM_REGEX;
	const cancelRegex = args.cancelRegex ?? DEFAULT_CANCEL_REGEX;
	const userId = String(args.message.entityId ?? args.message.id ?? "anon");
	const cacheKey = buildCacheKey(userId, args.actionName, args.pendingKey);
	const userText = readUserText(args.message);

	const existing = await args.runtime.getCache<PendingConfirmation>(cacheKey);
	const fresh =
		!existing || Date.now() - existing.createdAt > existing.ttlMs;

	if (fresh) {
		const record: PendingConfirmation = {
			actionName: args.actionName,
			pendingKey: args.pendingKey,
			prompt: args.prompt,
			createdAt: Date.now(),
			ttlMs,
			metadata: args.metadata,
		};
		await args.runtime.setCache(cacheKey, record);
		if (args.callback) {
			await args.callback({
				text: args.prompt,
				source: args.message.content?.source,
			});
		}
		return { status: "pending" };
	}

	// Existing pending record found — interpret the user's reply.
	await args.runtime.deleteCache(cacheKey);

	const isConfirmed = confirmRegex.test(userText);
	const isCancelled = !isConfirmed && cancelRegex.test(userText);
	const status: ConfirmationStatus =
		isConfirmed ? "confirmed" : isCancelled ? "cancelled" : "cancelled";
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
