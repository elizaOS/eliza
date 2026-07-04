/**
 * Chat pre-handlers — generic pre-action dispatch extension point.
 *
 * A pre-handler runs at the top of the chat generation loop, before normal
 * action processing and the first response model call. Plugins register
 * pre-handlers to fully resolve a turn deterministically (e.g. a direct skill
 * dispatch) when the incoming message matches their trigger, returning the
 * final user-facing text. Non-matching messages return `null` and fall through
 * to normal processing.
 *
 * The registry drains handlers by descending `priority`; the first non-null
 * result wins. This replaces host-hardcoded per-vendor short-circuits: the chat
 * loop knows only the generic drain, and each vendor owns its own trigger +
 * dispatch inside its plugin.
 */

import type { Memory } from "./memory";
import type { IAgentRuntime } from "./runtime";

/** Inputs available to a pre-handler for the current turn. */
export interface ChatPreHandlerContext {
	runtime: IAgentRuntime;
	message: Memory;
	/**
	 * Append text to the in-flight response stream (e.g. a loading hint the user
	 * sees immediately). Mirrors the chat loop's incremental callback path.
	 */
	appendText: (text: string) => void;
	/** Replace the entire in-flight response text with a final snapshot. */
	replaceText: (text: string) => void;
}

/** A pre-handler that fully resolved the turn. */
export interface ChatPreHandlerResult {
	/** The final user-facing response text. */
	responseText: string;
}

export interface ChatPreHandler {
	/** Stable id, unique per registry. */
	id: string;
	/** Higher runs first. Defaults to 0. */
	priority?: number;
	/**
	 * Attempt to fully handle the turn before normal action processing. Return a
	 * result to short-circuit the chat loop, or `null` to pass through.
	 */
	tryHandle(ctx: ChatPreHandlerContext): Promise<ChatPreHandlerResult | null>;
}
