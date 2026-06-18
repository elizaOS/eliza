/**
 * Compact codec for the answer a connector round-trips when the user taps a
 * native control (a choice button, a followup chip). The encoded string becomes
 * the platform's callback payload — Telegram caps `callback_data` at 64 bytes,
 * so encoding fails (returns null) when the answer is too large and the caller
 * falls back to a link-out or a free-text reply.
 *
 * The decoded answer is re-injected as an ordinary inbound user message, exactly
 * mirroring the dashboard's `sendActionMessage(value)` behavior, so downstream
 * routing (choice scopes, orchestrator turns) is identical across surfaces.
 */

const PREFIX = "ia1:";

/** Telegram's hard limit on `callback_data`. */
export const MAX_CALLBACK_BYTES = 64;

function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

/**
 * Encode an answer to be carried as connector callback data. Returns null when
 * the payload would exceed the platform limit — the caller should then link out
 * or accept a free-text reply instead of rendering a tappable control.
 */
export function encodeReplyCallback(value: string): string | null {
	const data = `${PREFIX}${value}`;
	return byteLength(data) <= MAX_CALLBACK_BYTES ? data : null;
}

export interface DecodedCallback {
	kind: "reply";
	/** The user-message text to re-inject. */
	value: string;
}

/** True when a platform callback payload was produced by `encodeReplyCallback`. */
export function isInteractionCallback(data: unknown): data is string {
	return typeof data === "string" && data.startsWith(PREFIX);
}

/** Decode a callback payload back to the answer, or null when it isn't ours. */
export function decodeCallback(data: unknown): DecodedCallback | null {
	if (!isInteractionCallback(data)) return null;
	return { kind: "reply", value: data.slice(PREFIX.length) };
}
