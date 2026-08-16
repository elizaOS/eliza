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
  String.raw`\b(?:(?:please\s+)?remind\s+me\s+to|(?:set|create|add)(?:\s+me)?\s+(?:a\s+)?reminder\s+(?:to|for))\s+[^.!?\n]{1,200}?\s+in\s+(${NUMBER_TOKEN})\s*${UNIT_TOKEN}(?=\s*(?:[.!?]|$))`,
  "gi",
);

const DECIMAL_TOKEN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const META_PREFIX =
  /(?:for\s+example|e\.g\.|example|say|write|quote|phrase|wording|text)\s*[:;,-]?\s*$/i;
const NEGATED_COMMAND_PREFIX =
  /\b(?:do\s+not|don['’]?t|dont|never)\s+(?:please\s+)?$/i;

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
  rawNumber: string;
  unit: keyof typeof UNIT_MILLISECONDS;
  negated: boolean;
}

function maskQuotedText(text: string): string {
  return text.replace(
    /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’/g,
    (match) => " ".repeat(match.length),
  );
}

function candidateIsExample(text: string, index: number): boolean {
  return META_PREFIX.test(text.slice(Math.max(0, index - 80), index));
}

function candidateIsNegated(text: string, index: number): boolean {
  return NEGATED_COMMAND_PREFIX.test(
    text.slice(Math.max(0, index - 40), index),
  );
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
        rawNumber,
        unit: rawUnit as keyof typeof UNIT_MILLISECONDS,
        negated: candidateIsNegated(text, match.index),
      });
    }
  }
  const compoundPattern = new RegExp(
    String.raw`^\s*(?:and|or|,)\s+(?:in\s+)?(${NUMBER_TOKEN})\s*${UNIT_TOKEN}\b`,
    "i",
  );
  for (const candidate of [...candidates]) {
    const compound = text.slice(candidate.end).match(compoundPattern);
    const rawNumber = compound?.[1];
    const rawUnit = compound?.[2]?.toLowerCase();
    if (compound && rawNumber && rawUnit && rawUnit in UNIT_MILLISECONDS) {
      candidates.push({
        index: candidate.end + (compound.index ?? 0),
        end: candidate.end + (compound.index ?? 0) + compound[0].length,
        rawNumber,
        unit: rawUnit as keyof typeof UNIT_MILLISECONDS,
        negated: candidate.negated,
      });
    }
  }
  return candidates.sort((left, right) => left.index - right.index);
}

function parseCandidate(candidate: DelayCandidate): number | undefined {
  const normalizedNumber = candidate.rawNumber.toLowerCase();
  const amount =
    NUMBER_WORDS[normalizedNumber] !== undefined
      ? NUMBER_WORDS[normalizedNumber]
      : DECIMAL_TOKEN.test(normalizedNumber)
        ? Number(normalizedNumber)
        : Number.NaN;
  const milliseconds = amount * UNIT_MILLISECONDS[candidate.unit];
  return Number.isFinite(amount) &&
    amount > 0 &&
    Number.isSafeInteger(milliseconds)
    ? milliseconds
    : undefined;
}

/**
 * Returns one exact command-position delay, or an explicit invalid result when
 * the user supplied multiple or non-positive supported delay expressions.
 */
export function resolveExplicitSharedReminderDelay(
  text: unknown,
): ExplicitSharedReminderDelay {
  if (typeof text !== "string" || !text.trim()) return { kind: "absent" };
  const candidates = collectCandidates(maskQuotedText(text));
  if (candidates.length === 0) return { kind: "absent" };
  if (candidates.length !== 1) {
    return {
      kind: "invalid",
      reason: "Use exactly one relative delay for a reminder.",
    };
  }
  if (candidates[0].negated) {
    return {
      kind: "invalid",
      reason: "A negated reminder command cannot create a reminder.",
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
