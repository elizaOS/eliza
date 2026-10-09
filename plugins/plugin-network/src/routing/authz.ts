/**
 * Deterministic authorizer for model-PROPOSED Network actions, ported from the
 * Network agent prototype (`thenetwork-poc/prototypes/poc-agent-llm/src/authz.ts`).
 * The model only proposes; this code decides whether anything changes.
 *
 * Ported rules that apply to SET_STATE:
 *  - input sanitization (Unicode tag smuggling, zero-width/bidi controls, NFKC);
 *  - evidence must be a verbatim (normalized) quote of the member's own text and
 *    must not sit inside quoted / forwarded third-party text;
 *  - state must be one of the member states, and `until` a valid, future date.
 * The prototype's item attribution (`attribution.ts`: thread/opportunity
 * targeting by reply-to and timeline) only applies to item-targeting actions
 * (RELAY_MESSAGE, SCHEDULE, RESPOND_TO_OPPORTUNITY, ...) and is not needed for
 * a self-only SET_STATE; it ports with those actions.
 */
import { NETWORK_MEMBER_STATES, type NetworkMemberState } from "../types.js";
import { resolveWindow, zonedNow } from "./dates.js";

/** Applied before evidence comparison (prototype `sanitize`). */
export function sanitize(text: string): string {
  return text
    .replace(/[\u{E0000}-\u{E007F}]/gu, "")
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .normalize("NFKC");
}

const norm = (text: string) =>
  sanitize(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'+@.]+/gu, " ")
    .trim();

/**
 * Spans quoting or reporting someone else (audit plugin-prototypes-6): "...", “...”, '...' and
 * ‘...’ (not apostrophes: "I'm", "don't"), lines starting with ">", what follows "X said" /
 * "wrote" / "texted" up to the end of that sentence or a "but", and a forwarded block to the end.
 */
interface QuotedSpanRange {
  start: number;
  end: number;
}

function capturedRange(
  match: RegExpMatchArray,
  value: string,
): QuotedSpanRange | null {
  const start = (match.index ?? 0) + match[0].indexOf(value);
  return start >= (match.index ?? 0)
    ? { start, end: start + value.length }
    : null;
}

function quotedSpanRanges(text: string): QuotedSpanRange[] {
  const ranges: QuotedSpanRange[] = [];
  for (const match of text.matchAll(/"([^"]{3,})"|“([^”]{3,})”/g)) {
    const value = match[1] ?? match[2];
    const range = value ? capturedRange(match, value) : null;
    if (range) ranges.push(range);
  }
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}])['‘]([^'‘’\n]{3,}?)['’](?![\p{L}\p{N}])/gu,
  )) {
    const range = match[1] ? capturedRange(match, match[1]) : null;
    if (range) ranges.push(range);
  }
  for (const match of text.matchAll(
    /\b(?:said|says|wrote|writes|texted|messaged|told me|asked me)\b\s*:?\s*([^\n.;!?]*?)(?=\s+but\b|[\n.;!?]|$)/gi,
  )) {
    const range =
      match[1] && match[1].trim().length >= 2
        ? capturedRange(match, match[1])
        : null;
    if (range) ranges.push(range);
  }
  const fwd =
    /(?:^|\n)[ \t]*(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:?|fwd?:)[\s\S]*$/i.exec(
      text,
    );
  if (fwd) {
    const start = fwd.index;
    ranges.push({ start, end: start + fwd[0].length });
  }
  let lineOffset = 0;
  for (const line of text.split("\n")) {
    const marker = /^\s*>/.exec(line);
    if (marker) {
      ranges.push({
        start: lineOffset + marker[0].length,
        end: lineOffset + line.length,
      });
    }
    lineOffset += line.length + 1;
  }
  return ranges;
}

export function quotedSpans(text: string): string[] {
  return quotedSpanRanges(text).map(({ start, end }) => text.slice(start, end));
}

export function evidenceOk(
  evidence: string,
  memberText: string,
): { ok: true } | { ok: false; why: string } {
  const e = norm(evidence);
  const t = norm(memberText);
  if (e.length < 2) return { ok: false, why: "empty evidence" };
  if (!t.includes(e)) return { ok: false, why: "evidence not in member text" };
  if (quotedSpans(memberText).some((quote) => norm(quote).includes(e))) {
    return { ok: false, why: "evidence is inside quoted third-party text" };
  }
  return { ok: true };
}

// The evidence must say something about the proposed state (audit plugin-prototypes-2: "hi"
// authorized "paused"). Pause and busy share cues, because busy-vs-paused is settled below.
const PAUSE_OR_BUSY_CUE =
  /\b(?:pause|stop|break|hold|on hold|hold off|mute|snooze|quiet|step back|time off|me time|leave me|don'?t (?:send|message|text|contact|ping)|do not (?:send|message|text|contact|ping)|no (?:more )?(?:intros|introductions|messages|texts)|busy|slammed|swamped|underwater|buried|crazy|hectic|insane|nuts|fewer|less|go easy|only (?:ping|message|text|contact) me if|minimum|a lot going on|overwhelmed)\b/gi;
const STATE_CUE: Record<NetworkMemberState, RegExp> = {
  paused: PAUSE_OR_BUSY_CUE,
  busy: PAUSE_OR_BUSY_CUE,
  traveling:
    /\b(?:travel\w*|trip|away|out of town|vacation|holiday|abroad|fly\w*|visiting|heading|going to|off to|road|(?:in|to|at) \p{L}{3,})\b/giu,
  open: /\b(?:back|resume|unpause|un-pause|available|open|free again|ready|keep (?:them|em|'em|it) coming|send (?:me )?(?:more )?(?:intros|introductions)|start (?:sending|again)|turn (?:\w+ )?(?:back )?on|i'?m in|good to go)\b/gi,
};
const NEGATED =
  /\b(?:not|never|no longer|don'?t|do not|didn'?t|isn'?t|won'?t|can'?t|ain'?t|nothing)\s+(?:\w+\s+)?$/i;

/** True when the evidence names the proposed state and that cue is not negated ("don't pause", "not busy"). */
export function evidenceSupportsState(
  state: NetworkMemberState,
  evidence: string,
): boolean {
  const e = sanitize(evidence).toLowerCase().replace(/[‘’]/g, "'");
  for (const m of e.matchAll(STATE_CUE[state])) {
    if (!NEGATED.test(e.slice(0, m.index))) return true;
  }
  return false;
}

// Busy keeps intros flowing at a lower rate; paused stops them. Models over-read
// "swamped, hold off on new intros" as a full pause (6/40 in the 2026-10-07 eval),
// so a proposed pause is downgraded to busy unless the member's own words ask to stop.
const EXPLICIT_PAUSE =
  /\b(?:pause|unpause|stop|break|on hold|mute|snooze|don'?t (?:message|text|contact|ping)|do not (?:message|text|contact|ping)|no (?:more )?(?:intros|messages|texts))\b/i;
const BUSY_CUE =
  /\b(?:busy|slammed|swamped|underwater|buried|crazy|hectic|insane|nuts|fewer|less|go easy|only (?:ping|message|text|contact) me if|hold off on new|minimum)\b/i;

/** Applies the busy-vs-paused rule to a proposed state, using only the member's own (unquoted) words. */
export function resolveBusyVsPaused(
  state: NetworkMemberState,
  memberText: string,
): NetworkMemberState {
  if (state !== "paused") return state;
  const own = ownWords(memberText);
  return BUSY_CUE.test(own) && !EXPLICIT_PAUSE.test(own) ? "busy" : state;
}

// Date guards (2026-10-07 live eval): the model sometimes dropped an end date the
// member gave ("stop the intros until after new years" became an indefinite pause) or
// asked about dates it could resolve. Code never invents dates; it refuses a proposal
// that ignores or contradicts dates in the member's own words, and the agent asks.
const END_MARKER =
  /\b(?:until|till|til|thru|through|back (?:on|by|the|in)|after|for (?:a |an |the )?(?:\d+|one|two|three|four|five|six|few|a few|couple|a couple(?: of)?)\s*(?:days?|weeks?|months?))\b|\bthis week\b|\bnext week\b/i;
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const MONTH_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
const ORDINAL_RE = /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/gi;

/** Member's own words with quoted third-party spans removed. */
export function ownWords(memberText: string): string {
  const own = sanitize(memberText);
  // Find and remove quotes in the same normalized representation. Otherwise a
  // zero-width or compatibility character removed by sanitize() makes the raw
  // quote impossible to find, and third-party text survives as the member's.
  // Mask the exact ranges instead of replacing by value. The same phrase can
  // occur outside a quote, and value replacement can remove that earlier copy.
  const chars = own.split("");
  for (const { start, end } of quotedSpanRanges(own)) {
    chars.fill(" ", start, end);
  }
  return chars.join("");
}

export type DateGuard =
  | { ok: true }
  | { ok: false; reason: "missing until" | "date mismatch" };

/** Checks proposed dates against the dates the member actually stated. */
export function checkDates(
  state: NetworkMemberState,
  from: string | null,
  until: string | null,
  memberText: string,
): DateGuard {
  if (state === "open") return { ok: true };
  const own = ownWords(memberText);
  if (!until && END_MARKER.test(own))
    return { ok: false, reason: "missing until" };
  const proposed = [from, until]
    .filter((d): d is string => Boolean(d))
    .map((d) => new Date(d));
  if (proposed.length === 0) return { ok: true };
  const days = [...own.matchAll(ORDINAL_RE)].map((m) => Number(m[1]));
  if (days.length && !proposed.some((d) => days.includes(d.getUTCDate()))) {
    return { ok: false, reason: "date mismatch" };
  }
  // "I may be away" is not May: a bare "may" counts only after a date word or before a day number.
  const months = [...own.matchAll(MONTH_RE)]
    .filter(
      (m) =>
        m[1]?.toLowerCase() !== "may" ||
        /^\s*\d/.test(own.slice(m.index + 3)) ||
        /\b(?:in|until|till|til|thru|through|by|of|early|mid|late|since|from|before|after)\s+$/i.test(
          own.slice(0, m.index),
        ),
    )
    .map((m) => MONTHS.indexOf(m[1]?.slice(0, 3).toLowerCase()));
  if (
    months.length &&
    !proposed.some((d) => months.includes(d.getUTCMonth()))
  ) {
    // "until december" may resolve to Dec 1 or to the first of January; both name December.
    const lastDayOf = proposed.some(
      (d) =>
        d.getUTCDate() === 1 && months.includes((d.getUTCMonth() + 11) % 12),
    );
    if (!lastDayOf) return { ok: false, reason: "date mismatch" };
  }
  return { ok: true };
}

export interface ProposedSetState {
  state: NetworkMemberState;
  until: string | null;
  evidence: string;
}

export type SetStateDecision =
  | {
      allowed: true;
      state: NetworkMemberState;
      from: string | null;
      until: string | null;
    }
  | { allowed: false; reason: string };

export function authorizeSetState(
  proposal: {
    state: unknown;
    from?: unknown;
    until: unknown;
    evidence: unknown;
  },
  memberText: string,
  at: Date = new Date(),
  opts: { timeZone?: string | null } = {},
): SetStateDecision {
  // All date logic runs on the member's local calendar day (audit plugin-prototypes-3).
  const now = zonedNow(at, opts.timeZone);
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (
    typeof proposal.state !== "string" ||
    !(NETWORK_MEMBER_STATES as readonly string[]).includes(proposal.state)
  ) {
    return { allowed: false, reason: "invalid state" };
  }
  if (typeof proposal.evidence !== "string") {
    return { allowed: false, reason: "missing evidence" };
  }
  const evidence = evidenceOk(proposal.evidence, memberText);
  if (!evidence.ok) return { allowed: false, reason: evidence.why };
  if (
    !evidenceSupportsState(
      proposal.state as NetworkMemberState,
      proposal.evidence,
    )
  ) {
    return { allowed: false, reason: "evidence does not support state" };
  }
  let until: string | null = null;
  if (typeof proposal.until === "string" && proposal.until.trim()) {
    const parsed = Date.parse(proposal.until);
    if (Number.isNaN(parsed))
      return { allowed: false, reason: "invalid until" };
    // Allow a date-only "today"; reject anything already in the past.
    if (parsed < today) {
      return { allowed: false, reason: "until is in the past" };
    }
    until = new Date(parsed).toISOString();
  }
  let from: string | null = null;
  if (typeof proposal.from === "string" && proposal.from.trim()) {
    const parsed = Date.parse(proposal.from);
    if (Number.isNaN(parsed)) return { allowed: false, reason: "invalid from" };
    if (parsed < today)
      return { allowed: false, reason: "from is in the past" };
    // A window that starts today or earlier is simply "now".
    from = parsed > now.getTime() ? new Date(parsed).toISOString() : null;
  }
  // Dates stated in the member's own words win over the model's: resolved deterministically.
  const stated = resolveWindow(ownWords(memberText), now);
  if (stated.until) until = stated.until;
  if (stated.from)
    from = Date.parse(stated.from) > now.getTime() ? stated.from : null;
  // Re-check after the override: a stated date must not be in the past either (plugin-prototypes-M4).
  if (until && Date.parse(until) < today)
    return { allowed: false, reason: "until is in the past" };
  if (from && until && Date.parse(until) <= Date.parse(from)) {
    return { allowed: false, reason: "until is not after from" };
  }
  const state = resolveBusyVsPaused(
    proposal.state as NetworkMemberState,
    memberText,
  );
  const dates = checkDates(state, from, until, memberText);
  if (!dates.ok) return { allowed: false, reason: dates.reason };
  return {
    allowed: true,
    state,
    from: state === "open" ? null : from,
    until: state === "open" ? null : until,
  };
}
