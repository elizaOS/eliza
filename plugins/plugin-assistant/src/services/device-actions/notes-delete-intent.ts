import {
  extractUserText,
  type Memory,
  unwrapUserMessageText,
} from "@elizaos/core";
import {
  intentClauses,
  looksLikeActionExplanationRequest,
} from "../message/direct-action-heuristics.ts";

// The owner's own read/show request: at a clause start (after punctuation or a joining word,
// optionally after "please", "just" or "could you"), or with the note as its object ("read it").
// A note title ("show times") or "I already read" is not a request to read the note.
const READ_OR_SHOW_REQUEST =
  /(?:[\n,;:.!?—–]|\s-|\b(?:and|or|but|so|then|instead|rather)\b)\s*(?:(?:please|just|only|simply|actually|now|(?:can|could|would|will)\s+you)\s+)*(?:read|show)\b|\b(?:read|show)\s+(?:it|this|that|them|me|us|aloud|out|(?:the|my)\s+note)\b/iu;

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
  // intentClauses splits on "instead" and drops the word, so check it on the whole request,
  // with the read/show request on either side ("instead, read it", "show it instead").
  if (/\binstead\b/iu.test(original) && READ_OR_SHOW_REQUEST.test(original))
    return false;
  return !intentClauses(original).some((clause) =>
    /\b(?:do\s+not|don['’]?t|never|without)\b[\s\S]{0,80}\b(?:delet|remov|eras|chang)|\b(?:never\s+mind|cancel\s+(?:it|that|this|the\s+(?:request|deletion))|forget\s+(?:it|that)|read[- ]only)\b/iu.test(
      clause,
    ),
  );
}
