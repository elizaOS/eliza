/**
 * The strict whole-message call and text commands a phone with its own Phone
 * and Messages apps owns. Matching only routes the turn to the planner and its
 * owner-reviewed device operation; it never places a call or sends a text.
 */
export type AuthoredTelephonyRequest = "call" | "text";

// A dialable number as typed, or a short name ("mom", "Sam Lee").
const TARGET = String.raw`(?:\+?[\d(][\d\s().-]{5,}\d|[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,2})`;
const COURTESY = String.raw`^(?:(?:hey|hi|ok|okay)[,.!]?\s+)?(?:please,?\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
const CALL = new RegExp(
  `${COURTESY}(?:call|ring|phone|dial)\\s+(${TARGET})(?:,?\\s+(?:please|now|for\\s+me))?[.!?]*$`,
  "iu",
);
const TEXT = new RegExp(
  `${COURTESY}(?:text|sms|send\\s+(?:a\\s+)?(?:text|sms)(?:\\s+message)?\\s+to)\\s+(${TARGET})\\s*,?\\s+(?:saying|that|to\\s+say)\\s+\\S[\\s\\S]*$`,
  "iu",
);
// Words that make "call X" something else ("call it a day", "call me",
// "call Sam on WhatsApp") or name another service; those stay with the planner.
const NOT_A_PHONE_TARGET =
  /^(?:me|myself|us|it|this|that|them|him|her|back|off|out|up|in|a|an|the|someone|somebody|anyone)\b|\b(?:on|via|in|through|using|with|over|from|at|tomorrow|later|tonight|today)\b/iu;

export function authoredTelephonyRequest(
  text: string,
): AuthoredTelephonyRequest | undefined {
  const request = text.trim();
  if (request.length > 400) return;
  const call = CALL.exec(request);
  if (call && !NOT_A_PHONE_TARGET.test(call[1] ?? "")) return "call";
  const sms = TEXT.exec(request);
  if (sms && !NOT_A_PHONE_TARGET.test(sms[1] ?? "")) return "text";
  return;
}
