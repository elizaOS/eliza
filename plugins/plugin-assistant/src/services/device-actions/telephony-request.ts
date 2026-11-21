/**
 * The strict whole-message call, text and keypad commands a phone with its own
 * Phone and Messages apps owns. Matching only routes the turn to the planner
 * and its device operation; it never places a call or sends a text.
 */
import {
  isSmsSenderLookup,
  requestedSmsDraftRecipient,
} from "@elizaos/contracts/telephony-actions";
import { phoneDialNumber } from "./phone-dial-contract.ts";

export type AuthoredTelephonyRequest = "call" | "text" | "sender";

// A dialable number as typed, a short number written as bare digits ("911",
// "112", "311"), or a short name ("mom", "Sam Lee").
const target = (names: "{0,2}" | "{0,2}?") =>
  String.raw`(?:\+?[\d(][\d\s().-]{5,}\d|\d{3,6}|[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*)${names})`;
const TARGET = target("{0,2}");
// Words after the callee that only say how or when: "call mom again", "call
// Sam back", "call Maya right now, please". They never name anyone.
const TRAILING = String.raw`(?:,?\s+(?:please|now|right\s+now|right\s+away|again|back|asap|for\s+me))`;
const COURTESY = String.raw`^(?:(?:hey|hi|ok|okay)[,.!]?\s+)?(?:please,?\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
const CALL = new RegExp(
  `${COURTESY}(?:call|ring|phone|dial)\\s+(${TARGET})${TRAILING}*[.!?]*$`,
  "iu",
);
const textCommand = (recipient: string) =>
  new RegExp(
    `${COURTESY}(?:text|sms|send\\s+(?:a\\s+)?(?:text|sms)(?:\\s+message)?\\s+to)\\s+(${recipient})\\s*,?\\s+(?:saying|that|to\\s+say)\\s+\\S[\\s\\S]*$`,
    "iu",
  );
const TEXT = textCommand(TARGET);
// The same messages, with the name ending at the first "saying", "that" or
// "to say": "text mom saying that I'm late" is to "mom", not "mom saying".
const TEXT_RECIPIENT = textCommand(target("{0,2}?"));
// Emergency services named in words, or a short emergency number. "my
// emergency contact" names a contact, not a service.
const EMERGENCY_SERVICE = String.raw`(?:(?:an?|the|my\s+local|local)\s+)?(?:ambulances?|paramedics?|police|cops|fire\s+(?:department|brigade|service|truck)s?|fire\s*fighters?|emergency(?:\s+(?:services?|number|line))?(?!\s+contacts?)|9-?1-?1|1-?1-?2|9-?9-?9)(?![\p{L}\p{N}])`;
// The service ends its clause, or only says when, for whom or where: "call
// the police now", "send an ambulance to 12 Main St". "Get the police report",
// "get the emergency number for Spain" and "call for help with my homework"
// ask for something else and stay with the planner.
const EMERGENCY_END = String.raw`(?:\s+(?:now|right\s+now|right\s+away|immediately|please|asap|quick(?:ly)?|here|over\s+here|for\s+(?:me|us|him|her|them)|(?:to|at)\s+[^.!?;]+))*\s*(?:[,.!?;:]|$)`;
const EMERGENCY_REQUEST = new RegExp(
  // A call at the start of a clause ("call an ambulance", "I need help, call
  // emergency services now", "please get the police"), never a report of one
  // ("she said she'd call the police"); or a plain need ("I need an ambulance"),
  // never its denial ("I don't need an ambulance").
  String.raw`(?:(?:^|[,.!?;:]\s*|\b(?:please|quick|quickly|someone|somebody|and)\s+)(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:(?:call|ring|phone|dial|get|send|contact)(?:\s+(?:me|us))?(?:\s+for)?\s+${EMERGENCY_SERVICE}|call\s+for\s+help(?![\p{L}\p{N}]))|(?<!\b(?:don['’]?t|do\s+not|doesn['’]?t|does\s+not|didn['’]?t|did\s+not|won['’]?t|no|never)\s+)\bneed\s+(?:an?\s+|the\s+)?(?:ambulance|paramedics|police|fire\s+department)(?![\p{L}\p{N}]))${EMERGENCY_END}`,
  "iu",
);

/**
 * Whether the owner's message asks for emergency services ("call an
 * ambulance", "call the police", "call for help", "dial 911"). Such a
 * request always reaches the phone's own keypad, where the system dialer
 * handles the local emergency number; it is never refused.
 */
export function emergencyServicesRequest(text: string): boolean {
  const request = text.trim();
  return request.length <= 400 && EMERGENCY_REQUEST.test(request);
}

/** A contact query that names emergency services rather than a person ("emergency services", "the police"). */
export function namesEmergencyService(query: string): boolean {
  return new RegExp(
    String.raw`^(?:for\s+)?(?:${EMERGENCY_SERVICE}|help)[.!?]*$`,
    "iu",
  ).test(query.trim());
}

// Words that make "call X" something else ("call it a day", "call me",
// "call Sam on WhatsApp") or name another service; those stay with the planner.
// "phone dialer", "phone keypad" and "dial pad" name the keypad, not a callee.
// "call for help" and "call emergency services" name no contact, and "call mom
// and dad" names two: the planner handles them.
const NOT_A_PHONE_TARGET =
  /^(?:me|myself|us|it|this|that|them|him|her|back|off|out|up|in|a|an|the|someone|somebody|anyone|for|police|cops|emergency|ambulance|paramedics?)\b|\b(?:on|via|in|through|using|with|over|from|at|tomorrow|later|tonight|today|and|or)\b|&|^(?:dialer|dial\s?-?\s?pad|key\s?-?\s?pad|pad|number\s+pad|app)[.!?]*$/iu;

export function authoredTelephonyRequest(
  text: string,
): AuthoredTelephonyRequest | undefined {
  const request = text.trim();
  if (request.length > 400) return;
  const call = CALL.exec(request);
  if (call && !NOT_A_PHONE_TARGET.test(call[1] ?? "")) return "call";
  if (requestedSmsDraftRecipient(request)?.kind === "previous-sender")
    return "text";
  if (isSmsSenderLookup(request)) return "sender";
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

/** The recipient a whole-message call or text command names, as the owner wrote it. */
export type AuthoredTelephonyTarget =
  | { kind: "number"; number: string }
  | { kind: "contact"; query: string };

/**
 * The recipient of a whole-message call or text command ("call 415-555-0100",
 * "text my mom saying ..."), taken from the owner's own words: a written
 * number in its dial form, or the name they wrote. `target` is absent when
 * the command wrote something number-shaped that is not one dialable number.
 * The model's recipient never replaces this one.
 */
export function authoredTelephonyTarget(
  text: string,
):
  | { request: AuthoredTelephonyRequest; target?: AuthoredTelephonyTarget }
  | undefined {
  const request = authoredTelephonyRequest(text);
  if (!request) return;
  // A greedy name also takes a trailing "please", "again", "back" or "right
  // now", and "Maya's mobile" names Maya: the address book has no "Maya's".
  const written = (request === "call" ? CALL : TEXT_RECIPIENT)
    .exec(text.trim())?.[1]
    ?.replace(/[.!?]+$/u, "")
    .replace(new RegExp(`${TRAILING}+$`, "iu"), "")
    .replace(
      /['’]s\s+(?:cell(?:\s+phone)?|mobile(?:\s+phone)?|phone|work(?:\s+phone)?|home(?:\s+phone)?|office|landline)(?:\s+(?:number|line))?$/iu,
      "",
    )
    .trim();
  if (!written) return { request };
  if (/^[+\d(]/.test(written)) {
    try {
      return {
        request,
        target: { kind: "number", number: phoneDialNumber(written) },
      };
    } catch {
      return { request };
    }
  }
  // "call my mom": the address book knows "mom", not "my mom".
  const query = written.replace(/^(?:my|our)\s+/iu, "").replace(/[.!?]+$/u, "");
  return query ? { request, target: { kind: "contact", query } } : { request };
}

/**
 * Whether `text` (the owner's own words) writes `number` as a dial number.
 * A keypad filled in with any other number (one taken from an email, a page or
 * an earlier read) stays on its review card.
 */
export function writesDialNumber(text: string, number: string): boolean {
  let wanted: string;
  try {
    wanted = phoneDialNumber(number);
  } catch {
    return false;
  }
  for (const [written] of text.matchAll(/\+?[\d(][\d ().-]*\d/g)) {
    try {
      if (phoneDialNumber(written) === wanted) return true;
    } catch {
      // Not a dial number as written; keep looking.
    }
  }
  return false;
}
