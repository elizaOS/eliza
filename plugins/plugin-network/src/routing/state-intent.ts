/**
 * Design A's deterministic trigger for the must-call-SET_STATE requirement,
 * the same role the capability-wall regexes play for REMINDERS and TODO. It
 * only decides that the planner MUST call SET_STATE (which then validates and
 * may clarify); it never changes state by itself.
 */
import { ownWords } from "./authz.js";

/** Where the message starts, or after a first-person subject. */
const SELF = String.raw`(?:^|[.!?,;]\s*|\b(?:i'?m|i am|i'?ll be|i will be|i'?ve been|im)\s+)`;
const UNTIL = String.raw`(?:until|till|til|thru|through|for (?:a|the|two|three|\d+|a couple(?: of)?) (?:days?|weeks?|months?|bit|while)|this week|next week|rn|right now)`;

const STATE_PATTERNS: readonly RegExp[] = [
  // pause / resume
  /\b(?:pause|unpause|un-pause|resume|restart|stop|mute|snooze|hold)\b[\s\S]{0,40}\b(?:intros?|introductions?|the network|network|everything|messages|texts|me)\b/i,
  /\b(?:unpause|un-pause)\b/i,
  /\bon hold\b/i,
  /\b(?:take|taking|need|needs)\s+(?:a\s+)?break\b/i,
  /\bhold\s+off\b/i,
  /\b(?:don'?t|dont|do not|stop)\s+(?:send(?:ing)?|message|messaging|text(?:ing)?|ping(?:ing)?|contact(?:ing)?)\s+me\b/i,
  /\bturn\s+(?:the\s+|my\s+)?(?:intros?|introductions?|network)\s+(?:back\s+)?(?:on|off)\b/i,
  // busy / quiet
  new RegExp(
    `${SELF}(?:\\w+\\s+)?(?:busy|slammed|swamped|underwater|buried)\\b`,
    "i",
  ),
  new RegExp(
    `(?:${SELF}|\\bwork(?:'s| is)\\s+)(?:\\w+\\s+){0,2}(?:busy|slammed|swamped|underwater|buried|crazy|hectic|insane|nuts)\\b[\\s\\S]{0,30}\\b${UNTIL}\\b`,
    "i",
  ),
  /\bmark\s+me\s+(?:as\s+)?(?:busy|away|available|open|back)\b/i,
  /\b(?:fewer|less)\s+(?:messages|texts|intros|pings)\b/i,
  /\bgo\s+easy\s+on\b/i,
  /\bonly\s+(?:ping|message|text|contact)\s+me\s+if\b/i,
  // traveling
  new RegExp(
    `${SELF}(?:(?:heading|going|flying|off|back)\\s+)?(?:to|in)\\s+[\\p{L}][\\p{L}-]+(?:\\s+[\\p{L}][\\p{L}-]+)?\\s+(?:from\\s+[\\s\\S]{0,20}\\s+)?${UNTIL}\\b`,
    "iu",
  ),
  new RegExp(`${SELF}(?:heading|going|flying|off)\\s+to\\s+[\\p{L}]`, "iu"),
  new RegExp(`${SELF}(?:traveling|travelling|out of town|away)\\b`, "i"),
  // back / open
  /\b(?:i'?m|i am|im)\s+back\b(?![\s\S]{0,20}\bfrom (?:the )?(?:gym|store|work|lunch|class|shower|run)\b)/i,
  /^\s*back from\b(?![\s\S]{0,6}\b(?:the )?(?:gym|store|lunch|class|shower|run)\b)/i,
  /\b(?:open|available|free|ready)\s+(?:again|for intros|to intros|for introductions)\b/i,
  /\b(?:i'?m|i am|im)\s+(?:open|available|free)\s+(?:again|(?:to|for)\s+(?:new\s+)?(?:intros|introductions))\b/i,
  /\b(?:open|available)\s+(?:to|for)\s+(?:meeting|new|more)\b/i,
  /\b(?:send|start sending)\s+(?:me\s+)?(?:intros|introductions)\b/i,
];

const NOT_STATE: readonly RegExp[] = [
  /\b(?:gym|membership|subscription|spotify|netflix|music|song|podcast|video)\b/i,
];

export function isNetworkStateIntent(text: string): boolean {
  // Quoted, reported or forwarded third-party text never triggers the requirement.
  const value = ownWords(text).trim();
  if (!value) return false;
  if (NOT_STATE.some((pattern) => pattern.test(value))) return false;
  return STATE_PATTERNS.some((pattern) => pattern.test(value));
}
