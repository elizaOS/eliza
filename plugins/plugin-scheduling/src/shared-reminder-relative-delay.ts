/**
 * Recovers an explicit relative reminder delay from the current user command.
 * Only command-position delays are authoritative so durations inside reminder
 * bodies, quoted examples, and model-generated parameters cannot move a timer.
 */

const NUMBER_TOKEN = String.raw`(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)|an?|one|[^\s,;:!?]+)`;
const UNIT_TOKEN = `(seconds?|minutes?|hours?)`;

const COMMAND_DELAY_PATTERN = new RegExp(
  String.raw`\b(?:(?:please\s+)?remind\s+me|(?:set|create|add)(?:\s+me)?\s+(?:a\s+)?reminder)\s+(?:for\s+)?in\s+(${NUMBER_TOKEN})\s*${UNIT_TOKEN}\b`,
  "gi",
);

const LEADING_DELAY_PATTERN = new RegExp(
  String.raw`(?:^|[.!?]\s+)(?:please\s+)?in\s+(${NUMBER_TOKEN})\s*${UNIT_TOKEN}\s*[,;:\-]?\s*(?:please\s+)?remind\s+me\b`,
  "gi",
);

const TRAILING_DELAY_PATTERN = new RegExp(
  String.raw`\b(?:(?:please\s+)?remind\s+me\s+to|(?:set|create|add)(?:\s+me)?\s+(?:a\s+)?reminder\s+(?:to|for))\s+[^.!?\n]{1,200}?\s+in\s+(${NUMBER_TOKEN})\s*${UNIT_TOKEN}\b`,
  "gi",
);

const DECIMAL_TOKEN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const META_PREFIX =
  /(?:for\s+example|e\.g\.|example|say|write|quote|phrase|wording|text)\s*[:;,-]?\s*$/i;
const NEGATION_TOKEN_PATTERN = /\b(?:do\s+not|don['’]?t|dont|never)\b/gi;
const POSITIVE_NEGATION_IDIOM =
  /^(?:do\s+not|don['’]?t|dont)\s+(?:mind|forget)\b/i;
const CLAUSE_RESET_PATTERN = /[.!?\n;]|\b(?:but|however|though|yet)\b/gi;
const BARE_REMINDER_DELAY_PATTERN = new RegExp(
  String.raw`\breminder\b[^.!?\n]{0,100}?\bin\s+${NUMBER_TOKEN}\s*${UNIT_TOKEN}\b`,
  "gi",
);

const UNIT_MILLISECONDS = {
  second: 1_000,
  seconds: 1_000,
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
} as const;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export type ExplicitSharedReminderDelay =
  | { kind: "absent" }
  | { kind: "resolved"; milliseconds: number }
  | { kind: "invalid"; reason: string };

interface DelayCandidate {
  index: number;
  end: number;
  terms: Array<{
    rawNumber: string;
    unit: keyof typeof UNIT_MILLISECONDS;
  }>;
  negated: boolean;
  invalidComposition: boolean;
}

function maskQuotedText(text: string): string {
  const closingQuote = new Map([
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
    ["‘", "’"],
  ]);
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const closer = closingQuote.get(text[cursor] ?? "");
    if (!closer) {
      out.push(text[cursor] ?? "");
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (end < text.length && text[end] !== "\n" && text[end] !== closer) {
      end += 1;
    }
    if (text[end] === closer) {
      out.push(" ".repeat(end - cursor + 1));
      cursor = end + 1;
      continue;
    }
    out.push(text.slice(cursor, end));
    cursor = end;
  }
  return out.join("");
}

function candidateIsExample(text: string, index: number): boolean {
  return META_PREFIX.test(text.slice(Math.max(0, index - 80), index));
}

function currentClausePrefix(text: string, index: number): string {
  const prefix = text.slice(Math.max(0, index - 160), index);
  CLAUSE_RESET_PATTERN.lastIndex = 0;
  let start = 0;
  for (const boundary of prefix.matchAll(CLAUSE_RESET_PATTERN)) {
    start = (boundary.index ?? 0) + boundary[0].length;
  }
  return prefix.slice(start);
}

function prefixNegatesCommand(prefix: string): boolean {
  NEGATION_TOKEN_PATTERN.lastIndex = 0;
  let negated = false;
  for (const token of prefix.matchAll(NEGATION_TOKEN_PATTERN)) {
    negated = !POSITIVE_NEGATION_IDIOM.test(prefix.slice(token.index ?? 0));
  }
  return negated;
}

function candidateIsNegated(text: string, index: number): boolean {
  return prefixNegatesCommand(currentClausePrefix(text, index));
}

function hasNegatedBareReminderDelay(text: string): boolean {
  BARE_REMINDER_DELAY_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(BARE_REMINDER_DELAY_PATTERN)) {
    if (
      match.index !== undefined &&
      prefixNegatesCommand(currentClausePrefix(text, match.index))
    ) {
      return true;
    }
  }
  return false;
}

const DURATION_CONTINUATION_PATTERN = new RegExp(
  String.raw`^\s*(?:(and|or|plus|,)\s+)?(in\s+)?(${NUMBER_TOKEN})\s*${UNIT_TOKEN}\b`,
  "i",
);
const HALF_CONTINUATION_PATTERN = /^\s*(?:and|plus)\s+(?:a\s+)?half\b/i;
const COMMAND_SEPARATOR = "(?:[,.;:!?—–-]+|…)";

const IMMEDIATE_REVISION_PATTERN = new RegExp(
  String.raw`^\s*${COMMAND_SEPARATOR}?\s*(?:(?:but|however)\s*${COMMAND_SEPARATOR}?\s*)?(?:actually|instead)\s*${COMMAND_SEPARATOR}?\s*(?:make|set|change)(?:\s+(?:it|that))?\s+(?:(?:for|to|in)\s+)?(${NUMBER_TOKEN})\s*${UNIT_TOKEN}\b`,
  "i",
);

const LATER_CANCELLATION_PATTERN = new RegExp(
  String.raw`^\s*${COMMAND_SEPARATOR}?\s*(?:(?:but|however)\s*${COMMAND_SEPARATOR}?\s*)?(?:(?:actually\s*${COMMAND_SEPARATOR}?\s*please|please\s*${COMMAND_SEPARATOR}?\s*actually|actually|please)\s*${COMMAND_SEPARATOR}?\s*)?(?:(?:do\s+not|don['’]?t|dont|never)(?:\s+ever)?\s+(?:please\s+)?(?:remind\s+me|(?:set|create|add)(?:\s+me)?\s+(?:a\s+)?reminder)\b|(?:never\s+mind\b|cancel(?:\s+(?:that(?:\s+reminder)?|it|the\s+reminder))?\b)(?:\s*,?\s+please\b)?(?=\s*(?:[.!?…]+|$)))`,
  "i",
);

function extendDuration(text: string, candidate: DelayCandidate): void {
  let cursor = candidate.end;
  while (true) {
    const half = text.slice(cursor).match(HALF_CONTINUATION_PATTERN);
    if (half) {
      const previous = candidate.terms.at(-1);
      if (!previous) {
        candidate.invalidComposition = true;
        break;
      }
      candidate.terms.push({ rawNumber: "0.5", unit: previous.unit });
      candidate.end = cursor + half[0].length;
      cursor = candidate.end;
      continue;
    }
    const continuation = text
      .slice(cursor)
      .match(DURATION_CONTINUATION_PATTERN);
    const connector = continuation?.[1]?.toLowerCase();
    const repeatedIn = continuation?.[2];
    const rawNumber = continuation?.[3];
    const rawUnit = continuation?.[4]?.toLowerCase();
    if (
      !continuation ||
      !rawNumber ||
      !(rawUnit && rawUnit in UNIT_MILLISECONDS)
    ) {
      break;
    }
    candidate.end = cursor + continuation[0].length;
    if (connector === "or" || repeatedIn) {
      candidate.invalidComposition = true;
    } else {
      candidate.terms.push({
        rawNumber,
        unit: rawUnit as keyof typeof UNIT_MILLISECONDS,
      });
    }
    cursor = candidate.end;
  }
}

function applyImmediateRevisions(
  text: string,
  candidate: DelayCandidate,
): void {
  while (true) {
    const revision = text
      .slice(candidate.end)
      .match(IMMEDIATE_REVISION_PATTERN);
    const rawNumber = revision?.[1];
    const rawUnit = revision?.[2]?.toLowerCase();
    if (!revision || !rawNumber || !(rawUnit && rawUnit in UNIT_MILLISECONDS)) {
      return;
    }
    candidate.terms = [
      {
        rawNumber,
        unit: rawUnit as keyof typeof UNIT_MILLISECONDS,
      },
    ];
    candidate.invalidComposition = false;
    candidate.end += revision[0].length;
    extendDuration(text, candidate);
  }
}

function hasLaterCancellation(
  text: string,
  candidate: DelayCandidate,
): boolean {
  return LATER_CANCELLATION_PATTERN.test(text.slice(candidate.end));
}

function collectCandidates(text: string): DelayCandidate[] {
  const candidates: DelayCandidate[] = [];
  for (const pattern of [
    COMMAND_DELAY_PATTERN,
    LEADING_DELAY_PATTERN,
    TRAILING_DELAY_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const rawNumber = match[1];
      const rawUnit = match[2]?.toLowerCase();
      if (
        match.index === undefined ||
        rawNumber === undefined ||
        !(rawUnit && rawUnit in UNIT_MILLISECONDS) ||
        candidateIsExample(text, match.index)
      ) {
        continue;
      }
      candidates.push({
        index: match.index,
        end: match.index + match[0].length,
        terms: [
          {
            rawNumber,
            unit: rawUnit as keyof typeof UNIT_MILLISECONDS,
          },
        ],
        negated: candidateIsNegated(text, match.index),
        invalidComposition: false,
      });
    }
  }
  const ordered = candidates.sort((left, right) => left.index - right.index);
  for (const candidate of ordered) extendDuration(text, candidate);
  if (ordered.length === 1) applyImmediateRevisions(text, ordered[0]);
  return ordered;
}

function parseCandidate(candidate: DelayCandidate): number | undefined {
  let total = 0;
  for (const term of candidate.terms) {
    const normalizedNumber = term.rawNumber.toLowerCase();
    const amount =
      NUMBER_WORDS[normalizedNumber] !== undefined
        ? NUMBER_WORDS[normalizedNumber]
        : DECIMAL_TOKEN.test(normalizedNumber)
          ? Number(normalizedNumber)
          : Number.NaN;
    const milliseconds = amount * UNIT_MILLISECONDS[term.unit];
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isSafeInteger(milliseconds) ||
      !Number.isSafeInteger(total + milliseconds)
    ) {
      return undefined;
    }
    total += milliseconds;
  }
  return total > 0 ? total : undefined;
}

/**
 * Returns one exact command-position delay, or an explicit invalid result when
 * the user supplied multiple or non-positive supported delay expressions.
 */
export function resolveExplicitSharedReminderDelay(
  text: unknown,
): ExplicitSharedReminderDelay {
  if (typeof text !== "string" || !text.trim()) return { kind: "absent" };
  const commandText = maskQuotedText(text);
  if (hasNegatedBareReminderDelay(commandText)) {
    return {
      kind: "invalid",
      reason: "A negated reminder command cannot create a reminder.",
    };
  }
  const candidates = collectCandidates(commandText);
  if (candidates.length === 0) return { kind: "absent" };
  if (candidates.length !== 1) {
    return {
      kind: "invalid",
      reason: "Use exactly one relative delay for a reminder.",
    };
  }
  if (
    candidates[0].negated ||
    hasLaterCancellation(commandText, candidates[0])
  ) {
    return {
      kind: "invalid",
      reason: "A negated reminder command cannot create a reminder.",
    };
  }
  if (candidates[0].invalidComposition) {
    return {
      kind: "invalid",
      reason: "Use one unambiguous relative delay for a reminder.",
    };
  }

  const milliseconds = parseCandidate(candidates[0]);
  return milliseconds === undefined
    ? {
        kind: "invalid",
        reason:
          "The relative reminder delay must be a positive supported duration.",
      }
    : { kind: "resolved", milliseconds };
}
