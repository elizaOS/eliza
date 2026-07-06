/**
 * Compact codec for the answer a connector round-trips when the user taps a
 * native control (a choice button, a followup chip). The encoded string becomes
 * the platform's callback payload. Telegram caps `callback_data` at 64 bytes
 * while Discord custom IDs allow a larger budget, so callers pass their native
 * limit and encoding fails (returns null) only when that surface cannot carry
 * the answer.
 *
 * The decoded answer is re-injected as an ordinary inbound user message, exactly
 * mirroring the dashboard's `sendActionMessage(value)` behavior, so downstream
 * routing (choice scopes, orchestrator turns) is identical across surfaces.
 */

const PREFIX = "ia1:";

/** Telegram's hard limit on `callback_data`. */
export const MAX_CALLBACK_BYTES = 64;

export interface EncodeReplyCallbackOptions {
	/** Maximum encoded callback payload length for the target platform. */
	maxBytes?: number;
}

function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

/**
 * Encode an answer to be carried as connector callback data. Returns null when
 * the payload would exceed the platform limit — the caller should then link out
 * or accept a free-text reply instead of rendering a tappable control.
 */
export function encodeReplyCallback(
	value: string,
	options: EncodeReplyCallbackOptions = {},
): string | null {
	const data = `${PREFIX}${value}`;
	const maxBytes = options.maxBytes ?? MAX_CALLBACK_BYTES;
	return byteLength(data) <= maxBytes ? data : null;
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
