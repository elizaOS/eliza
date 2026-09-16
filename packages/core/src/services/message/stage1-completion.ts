/** Interprets Stage 1 completion metadata and constructs the explicit completion-limit reply. */

import { SIMPLE_CONTEXT_ID } from "../../runtime/message-handler";
import type { MessageHandlerResult } from "../../types/components";
import type { GenerateTextResult } from "../../types/model";

export const STAGE1_COMPLETION_LIMIT_REPLY =
	"That answer got cut off before I could finish it. Please try again with a shorter request or ask for a narrower format.";

export function getStage1FinishReason(
	raw: string | GenerateTextResult,
): string {
	if (typeof raw === "string") return "";
	return typeof raw.finishReason === "string" ? raw.finishReason : "";
}

export function stage1HitCompletionLimit(
	raw: string | GenerateTextResult,
	maxTokens: number | undefined,
): boolean {
	if (typeof raw === "string") return false;
	const finishReason = getStage1FinishReason(raw).toLowerCase();
	if (
		/\b(?:length|max[-_\s]?tokens?|token[-_\s]?limit|output[-_\s]?limit)\b/u.test(
			finishReason,
		)
	) {
		return true;
	}
	// With direct-channel provider/model-max output, the runtime has no reliable
	// caller cap to compare against. Truncation is detected via finishReason.
	const completionTokens = raw.usage?.completionTokens;
	return (
		typeof maxTokens === "number" &&
		typeof completionTokens === "number" &&
		Number.isFinite(completionTokens) &&
		completionTokens >= maxTokens
	);
}

export function synthesizeStage1CompletionLimitReply(): MessageHandlerResult {
	return {
		processMessage: "RESPOND",
		thought:
			"Stage 1 hit the completion limit and no complete replyText field could be recovered.",
		plan: {
			contexts: [SIMPLE_CONTEXT_ID],
			reply: STAGE1_COMPLETION_LIMIT_REPLY,
			simple: true,
			requiresTool: false,
		},
	};
}
