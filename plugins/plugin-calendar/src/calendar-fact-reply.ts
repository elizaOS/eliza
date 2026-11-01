/**
 * Finds a reply that states the owner's Calendar facts: when an event is, or
 * what a day holds. Stage 1 gets no Calendar records, so a direct reply with
 * such a fact restates chat history or invents it. Live tj-90caa2045f354a and
 * tj-91807fc80cdfb9 ("So is QA coffee today?") shipped "No, QA coffee is
 * tomorrow, Monday, November 2, 9:00 to 10:00 AM Pacific. Not today." with no
 * Calendar read.
 *
 * English assertions only. A sentence counts when it has an assertion verb and
 * either Calendar vocabulary with a day or clock time, or a day or date with a
 * clock time or range. Questions, offers, promises, conditionals, statements
 * of the current date or time, and reminder, note, task, weather and clock
 * topics never count.
 */

import type { CalendarReadBinding } from "@elizaos/contracts";

const WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE = `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b|\\b\\d{1,2}/\\d{1,2}\\b`;
const DAY = new RegExp(
  `\\b(?:today|tonight|tomorrow|yesterday|${WEEKDAY})\\b|\\b(?:this|next)\\s+(?:morning|afternoon|evening|week|weekend)\\b|${DATE}`,
);
const CLOCK =
  /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\bnoon\b|\bmidnight\b/;
const RANGE =
  /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)?\s?(?:-|to|until|till)\s?\d{1,2}(?::\d{2})?\b/;
const VOCABULARY =
  /\b(?:calendar|schedule|scheduled|agenda|meetings?|events?|appointments?|booked)\b/;
const PREDICATE = new RegExp(
  `\\b(?:is|are|was|were|isn't|aren't|wasn't|weren't|starts?|started|begins?|began|ends?|ended|runs?|ran|happens?|happened|scheduled|booked|moved|said|mentioned|told you|you have|you've got|you had)\\b|'(?:s|re)\\s+(?:\\d+|today|tonight|tomorrow|yesterday|${WEEKDAY}|this|next|on|at|from|scheduled|booked|set|still|actually|not)\\b`,
);
// Offers, promises, conditionals and stated limits are not Calendar facts.
const NOT_ASSERTED =
  /^(?:if|once|when|whenever|unless|want me|would you|do you|should i|shall i|can i|i can|i could|i'll|i will|i'd|i would|let me|i'm going to|i am going to|i need to|i don't|i do not|i haven't|i have not|i'm not|i am not)\b/;
const OTHER_TOPIC =
  /\b(?:remind\w*|alarms?|timers?|notes?|tasks?|to-?dos?|routines?|habits?|weather|forecast|temperature|degrees|rain|snow|sunrise|sunset|daylight saving|time ?zones?|utc|gmt)\b/;
// "Today is Sunday, November 1." or "It's 3:45 PM." states the current date or
// time unless what follows also names a later day, the owner or a range.
const NOW_STATEMENT = new RegExp(
  `^(?:(?:right )?now,?\\s+)?(?:it|now|currently|the (?:current )?(?:date|time|day)|today(?:'s date)?|tonight|tomorrow|yesterday)\\s*(?:is|'s|was|will be)\\s+(?:currently\\s+|now\\s+|just\\s+|about\\s+|around\\s+|almost\\s+|nearly\\s+)?(?:a\\s+)?(?=${WEEKDAY}|${MONTH}\\s+\\d|\\d)`,
);
const EVENT_MARKER = new RegExp(
  `\\b(?:tomorrow|yesterday|tonight|next|you|your|you're|you've)\\b|${RANGE.source}|${VOCABULARY.source}`,
);
const LEADING_INTERJECTION =
  /^(?:(?:no|nope|yes|yeah|yep|yup|ok|okay|so|well|actually|and|but|also|sure|correct|nah)\b[\s,.!-]*)+/;

/** The Calendar read that would ground the first Calendar-fact sentence of a reply. */
export function calendarFactReadOperation(
  reply: string,
): Extract<
  CalendarReadBinding["operation"],
  "feed" | "next_event" | "search_events"
> | null {
  // "a.m." keeps its period only where it ends a sentence, so "It's 9 a.m.
  // Tomorrow is Monday." stays two sentences.
  const normalized = reply
    .replace(/\b([AaPp])\.[Mm]\.(?=\s+[A-Z])/g, "$1m.")
    .replace(/\b([AaPp])\.[Mm]\./g, "$1m")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .replace(new RegExp(`\\b(${MONTH})\\.(?=\\s*\\d)`, "g"), "$1");
  for (const raw of normalized.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw
      .replace(/^[\s*>#-]+/, "")
      .replace(LEADING_INTERJECTION, "")
      .trim();
    if (
      !sentence ||
      sentence.endsWith("?") ||
      NOT_ASSERTED.test(sentence) ||
      OTHER_TOPIC.test(sentence) ||
      !PREDICATE.test(sentence)
    )
      continue;
    const now = NOW_STATEMENT.exec(sentence);
    if (now && !EVENT_MARKER.test(sentence.slice(now[0].length))) continue;
    const day = DAY.test(sentence);
    if (
      !(VOCABULARY.test(sentence) && (day || CLOCK.test(sentence))) &&
      !(day && (CLOCK.test(sentence) || RANGE.test(sentence)))
    )
      continue;
    if (/\bnext\s+(?:meeting|event|appointment|call)\b/.test(sentence))
      return "next_event";
    if (
      /\b(?:calendar|schedule|agenda|nothing|no (?:events|meetings|appointments))\b/.test(
        sentence,
      )
    )
      return "feed";
    return "search_events";
  }
  return null;
}
