/**
 * The strict whole-message call, text and keypad commands a phone with its own
 * Phone and Messages apps owns. Matching only routes the turn to the planner
 * and its device operation; it never places a call or sends a text.
 */
import { phoneDialNumber } from "./phone-dial-contract.ts";

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
// "phone dialer", "phone keypad" and "dial pad" name the keypad, not a callee.
const NOT_A_PHONE_TARGET =
  /^(?:me|myself|us|it|this|that|them|him|her|back|off|out|up|in|a|an|the|someone|somebody|anyone)\b|\b(?:on|via|in|through|using|with|over|from|at|tomorrow|later|tonight|today)\b|^(?:dialer|dial\s?-?\s?pad|key\s?-?\s?pad|pad|number\s+pad|app)[.!?]*$/iu;

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

// "the dialer", "my phone's keypad", "the dial pad", "the number pad app".
const KEYPAD = String.raw`(?:(?:the|my|your)\s+)?(?:phone(?:['’]s)?\s+)?(?:dialer|dial\s?-?\s?pad|key\s?-?\s?pad|number\s+pad)(?:\s+(?:app|screen|tab))?`;
const OPEN = String.raw`(?:open(?:\s+up)?|show(?:\s+me)?|bring\s+up|pull\s+up|get\s+me|give\s+me|go\s+to|switch\s+to|take\s+me\s+to|launch)`;
const KEYPAD_NUMBER = String.raw`(\+?[\d(][\d\s().-]*\d)`;
// "and type 415 302 4399 (in)", "with (the number) 4153024399 (filled in)".
const FILL_IN = String.raw`(?:,?\s+(?:and\s+)?(?:type|enter|put|punch|key|fill)(?:\s+in)?\s+${KEYPAD_NUMBER}(?:\s+(?:in|on\s+it|there))?|\s+(?:with|for)\s+(?:the\s+number\s+)?${KEYPAD_NUMBER}(?:\s+(?:filled\s+in|typed\s+in|in\s+it|on\s+it))?)`;
const KEYPAD_REQUEST = new RegExp(
  `${COURTESY}(?:(${OPEN})\\s+)?${KEYPAD}(?:${FILL_IN})?(?:,?\\s+(?:please|now|for\\s+me))?[.!?]*$`,
  "iu",
);

/**
 * "(please) open|show me|bring up the (phone) dialer|dial pad|keypad (and type
 * 415 302 4399)" or "dial pad with 4153024399" as the whole current message:
 * the Phone keypad, with the number filled in when one was written. These
 * words also name the Phone view, which opens on Recents. A keypad with no
 * verb needs a number ("keypad" alone stays with the planner), and anything
 * else ("open the dialer settings", "open the dialer and call mom", "what's
 * on my dialer history") stays with the planner. It never places a call.
 */
export function authoredKeypadRequest(
  text: string,
): { number?: string } | undefined {
  const request = text.trim();
  if (request.length > 200) return;
  const match = KEYPAD_REQUEST.exec(request);
  if (!match) return;
  const [, verb, typed, withNumber] = match;
  const written = typed ?? withNumber;
  if (!verb && written === undefined) return;
  if (written === undefined) return {};
  try {
    return { number: phoneDialNumber(written) };
  } catch {
    // Not one dialable number as written ("415 302 4399 and 5").
    return;
  }
}
