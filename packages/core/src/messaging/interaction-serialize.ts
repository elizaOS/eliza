import type {
	ChoiceInteraction,
	FollowupsInteraction,
	FormInteraction,
	InteractionBlock,
	TaskInteraction,
} from "../types/interactions";
import { trimEndWhitespace } from "../utils/string-boundaries";

function serializeForm(block: FormInteraction): string {
	const body = {
		id: block.id,
		...(block.title ? { title: block.title } : {}),
		...(block.description ? { description: block.description } : {}),
		...(block.submitLabel ? { submitLabel: block.submitLabel } : {}),
		fields: block.fields,
	};
	return `[FORM]\n${JSON.stringify(body)}\n[/FORM]`;
}

function serializeChoice(block: ChoiceInteraction): string {
	const lines = block.options.map((o) => `${o.value}=${o.label}`).join("\n");
	const flags = block.allowCustom ? " allow_custom" : "";
	return `[CHOICE:${block.scope} id=${block.id}${flags}]\n${lines}\n[/CHOICE]`;
}

function serializeFollowups(block: FollowupsInteraction): string {
	const lines = block.options
		.map(
			(o) =>
				`${o.kind === "reply" ? o.payload : `${o.kind}:${o.payload}`}=${o.label}`,
		)
		.join("\n");
	return `[FOLLOWUPS id=${block.id}]\n${lines}\n[/FOLLOWUPS]`;
}

function serializeTask(block: TaskInteraction): string {
	return `[TASK:${block.threadId}]${block.title}[/TASK]`;
}

/** Serialize a block to its wire marker. `secret` blocks return "". */
export function serializeInteractionBlock(block: InteractionBlock): string {
	switch (block.kind) {
		case "form":
			return serializeForm(block);
		case "choice":
			return serializeChoice(block);
		case "followups":
			return serializeFollowups(block);
		case "task":
			return serializeTask(block);
		case "secret":
			return "";
		default: {
			const _exhaustive: never = block;
			return _exhaustive;
		}
	}
}

/** Append a block's marker to `text` (with a separating blank line when needed). */
export function appendInteractionBlock(
	text: string,
	block: InteractionBlock,
): string {
	const marker = serializeInteractionBlock(block);
	if (!marker) return text;
	if (!text.trim()) return marker;
	return `${trimEndWhitespace(text)}\n\n${marker}`;
}

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
