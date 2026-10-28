import {
  extractUserText,
  type Memory,
  unwrapUserMessageText,
} from "@elizaos/core";
import {
  intentClauses,
  looksLikeActionExplanationRequest,
} from "../message/direct-action-heuristics.ts";

/** Conservative current-request admission, never model-authored afterRead authority.
 * Unknown/compound wording keeps ordinary Notes planning; it does not unlock this continuation.
 * This recognizes a direct Notes deletion imperative only, not note payload instructions. */
export function originalRequestsNotesDeletion(
  value: Memory | string | null | undefined,
): boolean {
  if (!value) return false;
  const original = extractUserText(
    unwrapUserMessageText(
      typeof value === "string"
        ? ({ content: { text: value } } as Memory)
        : value,
    ),
  );
  if (!original || looksLikeActionExplanationRequest(original)) return false;
  if (
    !/^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:delete|remove|erase)\s+(?:only\s+)?(?:(?:the|this|that|my|one|a)\s+)?note\b/iu.test(
      original,
    )
  )
    return false;
  // Keep a later cancellation/read-only instruction authoritative, even after a command prefix.
  // Declining this optimized continuation is safe; the existing planner can clarify.
  return !intentClauses(original).some((clause) =>
    /\b(?:do\s+not|don['’]?t|never|without)\b[\s\S]{0,80}\b(?:delet|remov|eras|chang)|\b(?:never\s+mind|cancel\s+(?:it|that|this|the\s+(?:request|deletion))|forget\s+(?:it|that)|read[- ]only|instead\s+(?:read|show))\b/iu.test(
      clause,
    ),
  );
}
