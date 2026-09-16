/** Classifies Stage 1 retry conditions and recovers complete direct or planner responses from model output. */

import type {
  Action,
  GenerateTextResult,
  IAgentRuntime,
  Memory,
  MessageHandlerResult,
} from "@elizaos/core";
import { ChannelType, MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core";
import { parseMessageHandlerOutput } from "../../runtime/message-handler";
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
} from "./stage1-output.ts";
import {
  inferDirectCurrentRequestCandidateActions,
  synthesizeSimpleReplyFromPlainText,
} from "./stage1-reply-policy.ts";

/** Resolve conflicting completion/action declarations without guessing from reply prose. */
export function getStage1RoutingRepair(
  parsed: Record<string, unknown> | null,
): string | undefined {
  if (
    parsed?.shouldRespond !== "RESPOND" ||
    (parsed.replyEffectStatus !== "none" &&
      parsed.replyEffectStatus !== "non_applied") ||
    parsed.requiresTool === true ||
    typeof parsed.replyText !== "string" ||
    parsed.replyText.trim().length === 0 ||
    !Array.isArray(parsed.contexts) ||
    parsed.contexts.some((context) => typeof context !== "string") ||
    !Array.isArray(parsed.candidateActionNames) ||
    parsed.candidateActionNames.some((name) => typeof name !== "string") ||
    !Array.isArray(parsed.intents) ||
    parsed.intents.some((intent) => typeof intent !== "string") ||
    !parsed.intents.some((intent) => intent.trim().length > 0)
  )
    return undefined;
  const simple = parsed.contexts.every((context) => context === "simple");
  const visual = parsed.visualContinuation;
  // A general-context decision with no action candidate and an explicit
  // no-navigation declaration cannot represent its own pending intents either.
  // Repair the model's declarations, rather than guessing an action from prose.
  const missingRoute =
    parsed.contexts.every(
      (context) => context === "general" || context === "simple",
    ) &&
    parsed.candidateActionNames.length === 0 &&
    typeof visual === "object" &&
    visual !== null &&
    !Array.isArray(visual) &&
    "disposition" in visual &&
    visual.disposition === "none";
  if (!simple && !missingRoute) return undefined;
  return [
    "response_contract_repair:",
    "Your previous HANDLE_RESPONSE conflicts: a reply with replyEffectStatus=none or non_applied and no actionable route declares a completed conversational answer or a turn-ending preview, but nonempty intents declare pending runtime work. This is validation of that response, not a new user request. Nothing in it has been delivered or executed.",
    'Return HANDLE_RESPONSE with a consistent decision for the original request. If the supplied context and reply complete it, preserve the answer and use intents=[], candidateActionNames=[], contexts=["simple"], replyEffectStatus="none". A preview that must wait for the user keeps replyEffectStatus="non_applied" with intents=[]; a directive whose details the user already stated is not waiting on anything. If any action or external-state read remains, retain every pending outcome and route to the applicable planning contexts and known action candidates; mark a promised action reply pending. Do not discard pending actions to make the reply terminal, invent tool names, or claim an unverified effect. Use contextRequests if an advertised reference is needed.',
    "previous_model_response:",
    JSON.stringify(parsed),
  ].join("\n");
}

/**
 * An explicit RESPOND decision with no answer or pending work may receive
 * one model correction. STOP and IGNORE retain their terminal meaning without
 * attempting to classify disengagement from the language of the request.
 * Corrected output still passes normal terminal routing and reply validation.
 */
export function getStage1UnusableDecisionRepair(
  parsed: Record<string, unknown> | null,
): string | undefined {
  if (!parsed) return undefined;
  const shouldRespond = parsed.shouldRespond;
  const replyText =
    typeof parsed.replyText === "string" ? parsed.replyText.trim() : "";
  const contexts = Array.isArray(parsed.contexts) ? parsed.contexts : [];
  const intents = Array.isArray(parsed.intents)
    ? parsed.intents.filter(
        (intent) => typeof intent === "string" && intent.trim().length > 0,
      )
    : [];
  const candidates = Array.isArray(parsed.candidateActionNames)
    ? parsed.candidateActionNames
    : [];
  const contextRequests = Array.isArray(parsed.contextRequests)
    ? parsed.contextRequests
    : [];
  const endedWithoutAnswer =
    shouldRespond === "RESPOND" &&
    replyText.length === 0 &&
    parsed.requiresTool !== true &&
    contexts.every((context) => context === "simple") &&
    intents.length === 0 &&
    candidates.length === 0 &&
    contextRequests.length === 0;
  if (!endedWithoutAnswer) return undefined;
  return [
    "response_contract_repair:",
    "Your previous HANDLE_RESPONSE declared RESPOND but provided neither an answer nor pending work. A simple response must contain the complete nonempty answer. Reconsider the original request and all its instructions. This is validation of that response, not a new user request. Nothing in it has been delivered or executed.",
    'Return HANDLE_RESPONSE with a consistent decision for the original request: either answer it simply with a nonempty replyText, intents=[], candidateActionNames=[], contexts=["simple"], replyEffectStatus="none", or route it to the applicable planning contexts with the known action candidates and a pending reply. If the original request calls for disengagement or silence, use STOP or IGNORE without a reply or actions. Otherwise do not declare RESPOND with an empty reply and no pending work. Do not invent tool names or claim an unverified effect.',
    "previous_model_response:",
    JSON.stringify(parsed),
  ].join("\n");
}

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
