/**
 * REACTION_RECEIVED handler for plugin-neuro.
 *
 * WHY emoji reactions: they are the most natural, lowest-friction user feedback
 * mechanism available on chat platforms. A thumbs-up takes one click and
 * provides a strong quality signal. This handler translates platform-native
 * reactions into the optimization system's signal format.
 *
 * ADAPTER REQUIREMENT: The platform adapter must set `runId` on the reaction
 * Memory object (the run ID of the agent message being reacted to). Without
 * this field, the handler cannot associate the reaction with a trace and will
 * silently no-op. This is a platform adapter responsibility because the
 * mapping from "message being reacted to" → "run that produced it" is
 * platform-specific.
 */

import type { MessagePayload } from "../../types/events.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";
import { EMOJI_SENTIMENT, NEURO_SOURCE, SIGNALS } from "../signals.ts";

export async function handleReaction(
	payload: MessagePayload,
	runtime: IAgentRuntime,
): Promise<void> {
	const { message } = payload;
	if (!message?.content) return;

	// Extract emoji from message content
	const emoji =
		typeof message.content === "string"
			? message.content
			: ((message.content as Record<string, unknown>).text ?? "");
	const emojiStr = String(emoji).trim();

	const sentiment = EMOJI_SENTIMENT[emojiStr];
	if (sentiment === undefined) return;

	// Determine runId to attach signal to
	const runId = (message as unknown as Record<string, unknown>).runId as
		| string
		| undefined;
	if (!runId) return;

	if (sentiment >= 0.7) {
		runtime.enrichTrace(runId, {
			source: NEURO_SOURCE,
			kind: SIGNALS.REACTION_POSITIVE,
			value: sentiment,
			reason: `User reaction ${emojiStr} mapped to positive sentiment`,
			metadata: { emoji: emojiStr, messageId: message.id },
		});
	} else if (sentiment <= 0.3) {
		runtime.enrichTrace(runId, {
			source: NEURO_SOURCE,
			kind: SIGNALS.REACTION_NEGATIVE,
			value: sentiment,
			reason: `User reaction ${emojiStr} mapped to negative sentiment`,
			metadata: { emoji: emojiStr, messageId: message.id },
		});
	} else {
		runtime.enrichTrace(runId, {
			source: NEURO_SOURCE,
			kind: SIGNALS.REACTION_NEUTRAL,
			value: sentiment,
			reason: `User reaction ${emojiStr} mapped to neutral sentiment`,
			metadata: { emoji: emojiStr, messageId: message.id },
		});
	}
}
