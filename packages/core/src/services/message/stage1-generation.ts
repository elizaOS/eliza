/** Classifies Stage 1 retry conditions and recovers complete direct or planner responses from model output. */

import { parseMessageHandlerOutput } from "../../runtime/message-handler";
import type { Action, MessageHandlerResult } from "../../types/components";
import type { Memory } from "../../types/memory";
import { MESSAGE_SOURCE_CLIENT_CHAT } from "../../types/message-source";
import type { GenerateTextResult } from "../../types/model";
import { ChannelType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { textContainsAgentName } from "./addressing.js";
import {
	extractGenerateTextContentText,
	getV5ModelText,
} from "./generate-text-result";
import { stage1HitCompletionLimit } from "./stage1-completion.js";
import {
	applyDirectCurrentCandidateBackstopToMessageHandler,
	extractHandleResponseToolArguments,
	hasHandleResponseToolCall,
	parseMessageHandlerNativeToolCall,
} from "./stage1-output.js";
import {
	inferDirectCurrentRequestCandidateActions,
	synthesizeSimpleReplyFromPlainText,
} from "./stage1-reply-policy.js";

/**
 * Detect a Stage 1 model result with no usable content. Covers an empty
 * string, and the `GenerateTextResult` object shape where `text` is blank
 * AND there are no tool calls / content parts to recover from. Used to gate
 * bounded empty-completion retries.
 */
export function isEmptyStage1Result(raw: string | GenerateTextResult): boolean {
	if (typeof raw === "string") return raw.trim().length === 0;
	if (!raw || typeof raw !== "object") return true;
	// `raw` is narrowed to GenerateTextResult here; read its typed fields
	// directly while the guards still cover non-conforming provider output.
	const text = typeof raw.text === "string" ? raw.text.trim() : "";
	if (text.length > 0) return false;
	if (Array.isArray(raw.toolCalls) && raw.toolCalls.length > 0) return false;
	const contentText = extractGenerateTextContentText(raw);
	if (contentText.trim().length > 0) return false;
	return true;
}

export function getStage1RetryReason(
	raw: string | GenerateTextResult,
): "empty completion" | "malformed HANDLE_RESPONSE tool call" | null {
	if (isEmptyStage1Result(raw)) {
		return "empty completion";
	}
	if (typeof raw === "string" || !raw || typeof raw !== "object") {
		return null;
	}
	if (!hasHandleResponseToolCall(raw)) {
		return null;
	}
	if (extractHandleResponseToolArguments(raw)) {
		return null;
	}
	return "malformed HANDLE_RESPONSE tool call";
}

export function readStage1EmptyRetryLimit(runtime: IAgentRuntime): number {
	const raw = runtime.getSetting?.("ELIZA_RESPONSE_HANDLER_EMPTY_RETRIES");
	if (raw === undefined || raw === null || raw === "") return 2;
	const parsed =
		typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
	if (!Number.isFinite(parsed)) return 2;
	return Math.max(0, Math.min(5, Math.trunc(parsed)));
}

export function shouldUseStage1PlannerFallback(
	runtime: IAgentRuntime,
	message: Memory,
): boolean {
	const content = message.content ?? {};
	const channelType = String(content.channelType ?? "").toLowerCase();
	if (
		channelType === ChannelType.DM.toLowerCase() ||
		channelType === ChannelType.VOICE_DM.toLowerCase() ||
		channelType === ChannelType.SELF.toLowerCase() ||
		channelType === ChannelType.API.toLowerCase()
	) {
		return true;
	}
	const mentionContext = content.mentionContext as
		| { isMention?: boolean; isReply?: boolean }
		| undefined;
	if (mentionContext?.isMention === true || mentionContext?.isReply === true) {
		return true;
	}
	const source = String(content.source ?? "").toLowerCase();
	if (source.includes(MESSAGE_SOURCE_CLIENT_CHAT)) {
		return true;
	}
	return textContainsAgentName(content.text, [
		runtime.character.name,
		runtime.character.username,
	]);
}

export function synthesizePlannerFallbackFromStage1Failure(args: {
	reason: string;
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>;
	messageText: string;
}): MessageHandlerResult {
	const candidateActions = inferDirectCurrentRequestCandidateActions(
		args.actions,
		args.messageText,
	);
	return {
		processMessage: "RESPOND",
		thought: `Response handler returned ${args.reason}; falling back to planner because the message is explicitly addressed to the agent.`,
		plan: {
			contexts: ["general"],
			reply: "",
			simple: false,
			requiresTool: true,
			candidateActions,
		},
	};
}

/**
 * Stage 1 parse with a tolerant recovery chain. Models reached over OpenAI-
 * compatible providers do not all honour the native function-call path —
 * smaller instruct-tuned weights routinely emit the structured
 * HANDLE_RESPONSE envelope as a plain-text string, or skip structure
 * entirely and return prose. The chain, in priority order:
 *
 *   1. native function-call    — canonical, only valid for the object shape
 *   2. parseMessageHandlerOutput — the structured envelope emitted as text
 *      (`{"shouldRespond":...,"replyText":...,"contexts":[...]}`)
 *   3. synthesizeSimpleReplyFromPlainText — degenerate plain-text reply
 *
 * Returning `null` is the failure signal; callers route those to the
 * structured-failure reply path.
 */
export function parseMessageHandlerModelOutput(
	raw: string | GenerateTextResult,
	runtimeContext?: {
		actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
		messageText?: string;
		subAgentCompletionRelay?: boolean;
	},
): MessageHandlerResult | null {
	const applyBackstops = (result: MessageHandlerResult | null) =>
		result
			? applyDirectCurrentCandidateBackstopToMessageHandler(
					result,
					runtimeContext,
				)
			: null;
	if (typeof raw !== "string") {
		const native = parseMessageHandlerNativeToolCall(raw);
		if (native) return applyBackstops(native);
		const text = getV5ModelText(raw);
		return applyBackstops(
			parseMessageHandlerOutput(text) ??
				synthesizeSimpleReplyFromPlainText(text),
		);
	}
	return applyBackstops(
		parseMessageHandlerOutput(raw) ?? synthesizeSimpleReplyFromPlainText(raw),
	);
}

/**
 * Whether a Stage-1 result should be regenerated. Empty or garbled output can be
 * fixed by retrying, but hitting a completion limit cannot: regenerating at
 * the same token cap repeats the failure and burns a full Stage-1 turn. The
 * partial response is rejected explicitly. Exported for unit coverage.
 */
export function shouldRetryStage1Generation(
	reason: ReturnType<typeof getStage1RetryReason>,
	raw: string | GenerateTextResult,
	maxTokens: number | undefined,
): boolean {
	if (!reason) return false;
	return !stage1HitCompletionLimit(raw, maxTokens);
}
