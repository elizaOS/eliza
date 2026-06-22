/**
 * Tiny external store for the post-clear "undo" affordance.
 *
 * After a conversation reset (RotateCcw in ChatView / the overlay header), we
 * surface a brief glassmorphic toast that can restore the previous conversation
 * (#8929). The toast lives in ONE place (mounted at the app root) but is
 * triggered from several surfaces, so the request flows through this module-level
 * store rather than prop-drilling or a context. Consumers subscribe via
 * `useSyncExternalStore`.
 */

export interface ConversationUndoRequest {
	/** Monotonic id so the toast re-arms its auto-dismiss timer per request. */
	id: number;
	/** Message shown in the toast (e.g. "Conversation cleared"). */
	label: string;
	/** Action button text (e.g. "Undo"). */
	actionLabel: string;
	/** Invoked when the user taps Undo or swipes the toast to restore. */
	onUndo: () => void;
}

let current: ConversationUndoRequest | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function subscribeConversationUndo(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function getConversationUndoSnapshot(): ConversationUndoRequest | null {
	return current;
}

/** Show (or replace) the undo toast. Returns the request id. */
export function showConversationUndo(
	request: Omit<ConversationUndoRequest, "id">,
): number {
	counter += 1;
	current = { ...request, id: counter };
	emit();
	return current.id;
}

/**
 * Dismiss the undo toast. Pass an id to only dismiss if it is still the active
 * request (avoids a stale auto-dismiss timer closing a newer toast).
 */
export function dismissConversationUndo(id?: number): void {
	if (id !== undefined && current?.id !== id) return;
	if (current === null) return;
	current = null;
	emit();
}

/**
 * Surface the post-reset undo toast wired to restore a previous conversation.
 * Single source of truth so every reset surface (ChatView button, overlay
 * header) shows an identical affordance. No-op when there was no prior
 * conversation to restore.
 */
export function requestConversationResetUndo(opts: {
	previousConversationId: string | null;
	restore: (id: string) => void;
	translate?: (key: string) => string;
}): void {
	const { previousConversationId, restore, translate } = opts;
	if (!previousConversationId) return;
	const tr = (key: string, fallback: string): string => {
		const value = translate?.(key);
		return typeof value === "string" && value && value !== key
			? value
			: fallback;
	};
	showConversationUndo({
		label: tr("chat.conversationCleared", "Conversation cleared"),
		actionLabel: tr("common.undo", "Undo"),
		onUndo: () => restore(previousConversationId),
	});
}
