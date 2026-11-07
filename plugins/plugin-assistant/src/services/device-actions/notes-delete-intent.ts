import {
  extractUserText,
  type Memory,
  unwrapUserMessageText,
} from "@elizaos/core";
import {
  intentClauses,
  looksLikeActionExplanationRequest,
} from "../message/direct-action-heuristics.ts";

// Read/show right after "instead" or "rather" ("instead read it", "or rather show it"),
// optionally after "please", "just" or "could you".
const READ_OR_SHOW_AFTER_CANCEL =
  /\b(?:instead|rather)\b[\s,]*(?:(?:please|just|only|simply|actually|now|(?:can|could|would|will)\s+you)\s+)*(?:read|show)\b/iu;
// Read/show at a clause start (after punctuation, "and", "or", "but", "so" or "then") with the
// note itself as its object ("and show it", "and read me the note"). A note topic or title holds
// read/show after the same words with another object ("groceries and show times", "Agenda:
// show times"), so a bare read/show there never counts. "I already read" is not a request to read
// the note.
const READ_OR_SHOW_NOTE_AT_CLAUSE_START =
  /(?:[\n,;:.!?—–]|\s-|\b(?:and|or|but|so|then)\b)\s*(?:(?:please|just|only|simply|actually|now|(?:can|could|would|will)\s+you)\s+)*(?:read|show)\s+(?:(?:me|us)\s+)?(?:it|this|that|them|(?:the|my)\s+note)\b/iu;
// Read/show with the note as its object ("read it", "show me the note"), or "read aloud" / "read
// out loud" that ends the request ("read aloud instead", not "read aloud tips"). A note title can
// hold the same words ("the note titled read it later"), so this counts only when "instead"
// replaces the deletion, and never right where a topic or title starts ("the note called show it
// to clients").
const READ_OR_SHOW_NOTE =
  /(?<!\b(?:about|titled|called|named)\s+["'“‘]?)\b(?:(?:read|show)\s+(?:(?:me|us)\s+)?(?:it|this|that|them|(?:the|my)\s+note)\b|read\s+(?:aloud|out\s+loud)(?:\s+to\s+(?:me|us))?\b(?=[\s,]*(?:instead\b|[;:.!?—–]|$)))/iu;
// A quoted note title right after "about", "titled", "called", "named" or "note" ("titled \"Agenda:
// show it to clients\"") names the note; it is not the owner's request, so the checks skip it.
const QUOTED_NOTE_TITLE =
  /(\b(?:about|titled|called|named|note)\s+)(?:"[^"\n]*"|“[^”\n]*”|‘[^\n]*?’(?!\w)|'[^\n]*?'(?!\w))/giu;
// "instead" that replaces the deletion: adverbial ("read it instead") or set against the deletion
// itself ("instead of deleting it"), not a contrast with another note ("instead of the draft").
const INSTEAD_REPLACES_DELETION =
  /\binstead\b(?!\s+of\b)|\binstead\s+of\s+(?:delet|remov|eras)/iu;

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
  const request = original.replace(QUOTED_NOTE_TITLE, '$1""');
  if (
    /\binstead\b/iu.test(request) &&
    (READ_OR_SHOW_AFTER_CANCEL.test(request) ||
      READ_OR_SHOW_NOTE_AT_CLAUSE_START.test(request) ||
      (INSTEAD_REPLACES_DELETION.test(request) &&
        READ_OR_SHOW_NOTE.test(request)))
  )
    return false;
  return !intentClauses(original).some((clause) =>
    /\b(?:do\s+not|don['’]?t|never|without)\b[\s\S]{0,80}\b(?:delet|remov|eras|chang)|\b(?:never\s+mind|cancel\s+(?:it|that|this|the\s+(?:request|deletion))|forget\s+(?:it|that)|read[- ]only)\b/iu.test(
      clause,
    ),
  );
}
