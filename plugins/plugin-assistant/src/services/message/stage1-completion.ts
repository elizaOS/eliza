/** Interprets Stage 1 completion metadata and constructs the explicit completion-limit reply. */

import type { GenerateTextResult, MessageHandlerResult } from "@elizaos/core";
import { SIMPLE_CONTEXT_ID } from "../../runtime/message-handler";

export const STAGE1_COMPLETION_LIMIT_REPLY =
  "That answer got cut off before I could finish it. Please try again with a shorter request or ask for a narrower format.";

export function getStage1FinishReason(
  raw: string | GenerateTextResult,
): string {
  if (typeof raw === "string") return "";
  return typeof raw.finishReason === "string" ? raw.finishReason : "";
}

/**
 * Whether a Stage 1 generation stopped at an output limit. Stage 1 sends no
 * cap, so there is no caller cap to compare usage against: truncation is
 * detected from the provider's finish reason.
 */
export function stage1HitCompletionLimit(
  raw: string | GenerateTextResult,
): boolean {
  if (typeof raw === "string") return false;
  return /\b(?:length|max[-_\s]?tokens?|token[-_\s]?limit|output[-_\s]?limit)\b/u.test(
    getStage1FinishReason(raw).toLowerCase(),
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
