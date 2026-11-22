/**
 * Calendar event create, move and delete requests in the owner's own words
 * ("add an event called v613 check tomorrow at 3pm", "move v613 check to 4pm",
 * "delete the calendar event v613 check") reach the Calendar operations from
 * whatever view is in front.
 *
 * v613 device evidence (2026-11-18): with Contacts in front, the planner was
 * handed the open view's routing context ("contacts, general") and no Calendar
 * operation, and replied that calendar tools were "only available while
 * calendar is the registered context on this turn". The same request from
 * Browser or Home created the event. The open view is a relevance hint, not a
 * domain limit, so these routes add the calendar context and the requested
 * operation to the Stage-1 plan. They are additive (not whole-request owners):
 * the planner still sees other admitted work, and the operation still passes
 * the ordinary role, context, policy and validation gates before it runs.
 * Matching routes the turn only; it never creates, moves or deletes anything.
 */
import {
  type IAgentRuntime,
  type Memory,
  registerDirectActionRoutingRule,
} from "@elizaos/core";

export type CalendarEventRequest = "create" | "update" | "delete";

// "please", "can you", "hey, could you please".
const COURTESY = String.raw`^(?:(?:hey|hi|ok|okay)[,.!]?\s+)?(?:please,?\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
const EVENT_NOUN = String.raw`(?:calendar\s+)?(?:event|appointment|meeting|calendar\s+entry)s?`;
// Up to three describing words before the noun ("a dentist appointment", "my
// 3pm meeting"); a preposition ends them, so "add Sam to the meeting" is an
// attendee change, not a new event.
const DESCRIBING = String.raw`((?:(?!(?:to|from|for|with|on|in|at|into|onto|of)\b)[\p{L}\p{N}'’:.-]+\s+){0,3}?)`;
const DETERMINER = String.raw`(?:(?:a|an|the|my|one|this|that|our)\s+)?`;
const CREATE_VERB = String.raw`(?:add|create|make|schedule|book|put|set\s+up|plan|new)`;
const CREATE_EVENT = new RegExp(
  `${COURTESY}${CREATE_VERB}\\s+${DETERMINER}(?:new\\s+)?${DESCRIBING}${EVENT_NOUN}\\b(.*)$`,
  "isu",
);
// "add v613 check to my calendar", "put lunch with Sam on the calendar".
const CREATE_ON_CALENDAR = new RegExp(
  `${COURTESY}(?:add|put|schedule|book)\\s+(\\S[\\s\\S]*?)\\s+(?:to|on|in|onto|into)\\s+(?:my|the|our)\\s+calendar\\b`,
  "iu",
);
const DELETE_VERB = String.raw`(?:delete|remove|cancel|clear|drop|erase)`;
const DELETE_EVENT = new RegExp(
  `${COURTESY}${DELETE_VERB}\\s+${DETERMINER}${DESCRIBING}${EVENT_NOUN}\\b(.*)$`,
  "isu",
);
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const ORDINAL = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
// A calendar date: "November 25", "Nov 25th, 2026", "the 25th of November",
// "11/25", "2026-11-25".
const DATE = String.raw`(?:${MONTH}\s+${ORDINAL}(?:,?\s+\d{4})?|(?:the\s+)?${ORDINAL}\s+(?:of\s+)?${MONTH}(?:,?\s+\d{4})?|the\s+\d{1,2}(?:st|nd|rd|th)|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})`;
const DAY = String.raw`(?:today|tonight|tomorrow|(?:this|next)\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:on\s+)?(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:,?\s+${DATE})?|${DATE}))`;
// A written clock time: "4pm", "4:30", "10 a.m.", "noon". A bare number
// ("change my status to 5") is not one.
const CLOCK = String.raw`(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}|noon|midnight)`;
const WHEN = String.raw`(?:${DAY}(?:\s+(?:at\s+)?${CLOCK})?|${CLOCK}(?:\s+${DAY})?)`;
// "take v613 check off my calendar", "remove lunch from the calendar",
// "remove v613 check from my calendar tomorrow".
const DELETE_FROM_CALENDAR = new RegExp(
  `${COURTESY}(?:delete|remove|take|clear|drop)\\s+(\\S[\\s\\S]*?)\\s+(?:off|from|out\\s+of)\\s+(?:my|the|our)\\s+calendar(?:\\s+(?:for\\s+)?${WHEN})?[.!?]*$`,
  "iu",
);
// "move v613 check to 4pm", "reschedule the standup to tomorrow at 10",
// "move v613 check to November 25 at 2pm".
const MOVE_EVENT = new RegExp(
  `${COURTESY}(?:move|reschedule|push(?:\\s+back)?|shift|bump|change)\\s+(\\S[\\s\\S]*?)\\s+(?:to|until|till|for)\\s+${WHEN}(?:,?\\s+(?:please|now|instead))?[.!?]*$`,
  "iu",
);
const AMOUNT = String.raw`(?:(?:an?|one|two|three|four|five|six|half\s+an?|a\s+couple\s+of|\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|minutes?|mins?|days?|weeks?)|half\s+an\s+hour)`;
// "push v613 check back an hour", "move v613 check up 30 minutes",
// "bump the standup a day later".
const SHIFT_EVENT = new RegExp(
  `${COURTESY}(?:move|reschedule|push|shift|bump|delay|postpone)\\s+(\\S[\\s\\S]*?)\\s+(?:(?:back|forward|up|ahead|out|later|earlier)\\s+(?:by\\s+)?${AMOUNT}(?:\\s+(?:later|earlier))?|(?:by\\s+)?${AMOUNT}\\s+(?:later|earlier|back|forward|ahead|out))(?:,?\\s+(?:please|now|instead))?[.!?]*$`,
  "iu",
);
// "rename the event v613 check to v614 check", "edit my dentist appointment".
const EDIT_EVENT = new RegExp(
  `${COURTESY}(?:rename|update|edit|change|modify|retitle)\\s+${DETERMINER}${DESCRIBING}${EVENT_NOUN}\\b(.*)$`,
  "isu",
);
// Things other than events that the same verbs act on in this phone's apps.
const NOT_AN_EVENT =
  /\b(?:notes?|files?|folders?|reminders?|alarms?|timers?|contacts?|tabs?|photos?|pictures?|images?|videos?|albums?|messages?|texts?|emails?|mails?|tasks?|to-?dos?|workflows?|apps?|icons?|widgets?|windows?|songs?|tracks?|playlists?|wallpaper|brightness|volume|settings?|lists?|line|lines)\b/iu;
// An event word that only describes another record: "the meeting notes",
// "a meeting link", "the appointment reminder".
const EVENT_ATTRIBUTE = new RegExp(
  String.raw`^\s*(?:${NOT_AN_EVENT.source.slice(2, -2)}|links?|agendas?|minutes|recordings?|transcripts?|summar(?:y|ies))\b`,
  "iu",
);
// The event word sits inside another record: "delete the meeting from my
// notes", "add an event to my tasks".
const IN_OTHER_RECORD =
  /\b(?:from|in|into|to|on|onto|off)\s+(?:my|the|our|a|an|this|that)\s+(?:[\p{L}\p{N}'’-]+\s+)?(?:notes?|files?|folders?|reminders?|alarms?|timers?|contacts?|tabs?|photos?|albums?|messages?|texts?|emails?|tasks?|to-?dos?|workflows?|lists?|playlists?)\b/iu;
// A pronoun ("move it to 4pm") names its target only through the turn's
// history, which the referential effect reroute owns; the target may be an
// alarm, a reminder or a workflow rather than an event.
const PRONOUN = /^(?:it|that|this|them|those|these|that\s+one|this\s+one)$/iu;
// Non-event settings the same move/change verbs set to a time.
const NOT_AN_EVENT_TIME =
  /\b(?:status|clocks?|time\s*zone|timezone|thermostat|temperature|wake[\s-]?up|bedtime|sleep|quiet\s+hours|do\s+not\s+disturb|dnd|focus|schedule\s+send)\b/iu;

/** True when the matched event words name an event rather than describe another record. */
function namesEvent(describing: string, rest: string): boolean {
  return (
    !NOT_AN_EVENT.test(describing) &&
    !EVENT_ATTRIBUTE.test(rest) &&
    !IN_OTHER_RECORD.test(rest)
  );
}

function eventMatch(pattern: RegExp, request: string): boolean {
  const match = pattern.exec(request);
  return Boolean(match && namesEvent(match[1] ?? "", match[2] ?? ""));
}

function subjectMatch(pattern: RegExp, request: string): boolean {
  const match = pattern.exec(request);
  return Boolean(match && !NOT_AN_EVENT.test(match[1] ?? ""));
}

// The phone's own calendar is the device calendar review, not this route.
const PHONE_CALENDAR =
  /\b(?:phone|device|android|system|os)(?:['’]s)?\s+(?:own\s+)?calendar\b|\bcalendar\s+(?:app\s+)?on\s+(?:this|my|the)\s+(?:phone|device)\b/iu;

/**
 * Which Calendar event operation the owner's current message asks for, read
 * from their own words. Undefined for anything else, including a request that
 * names another record kind ("move the note v613 check to Work") or the phone's
 * own calendar.
 */
export function calendarEventRequest(
  text: string,
): CalendarEventRequest | undefined {
  const request = text.trim();
  if (!request || request.length > 300 || PHONE_CALENDAR.test(request)) return;
  if (
    eventMatch(DELETE_EVENT, request) ||
    subjectMatch(DELETE_FROM_CALENDAR, request)
  )
    return "delete";
  if (
    eventMatch(CREATE_EVENT, request) ||
    subjectMatch(CREATE_ON_CALENDAR, request)
  )
    return "create";
  for (const pattern of [MOVE_EVENT, SHIFT_EVENT]) {
    const move = pattern.exec(request);
    const subject = (move?.[1] ?? "").trim();
    if (
      move &&
      !PRONOUN.test(subject) &&
      !NOT_AN_EVENT.test(subject) &&
      !NOT_AN_EVENT_TIME.test(subject)
    )
      return "update";
  }
  if (eventMatch(EDIT_EVENT, request)) return "update";
  return;
}

const ROUTES: ReadonlyArray<{
  request: CalendarEventRequest;
  action: string;
  capability: string;
}> = [
  { request: "create", action: "CALENDAR_CREATE_EVENT", capability: "write" },
  { request: "update", action: "CALENDAR_UPDATE_EVENT", capability: "update" },
  { request: "delete", action: "CALENDAR_DELETE_EVENT", capability: "delete" },
];

/** Register the three Calendar event request routes on this runtime. */
export function registerCalendarEventRequestRouting(
  runtime: IAgentRuntime,
): void {
  for (const route of ROUTES) {
    const matches = (text: string, _message?: Memory) =>
      calendarEventRequest(text) === route.request;
    registerDirectActionRoutingRule(runtime, {
      id: `calendar.event-${route.request}-request`,
      actionNames: [route.action],
      // Opening the Calendar view creates, moves or deletes no event.
      replacesActionNames: ["VIEWS", "VIEWS_SHOW"],
      requiredActionTags: ["domain:calendar", `capability:${route.capability}`],
      contexts: ["calendar"],
      matches,
    });
  }
}
