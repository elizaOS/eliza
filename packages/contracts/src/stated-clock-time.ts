/** Shared unambiguous clock/range grammar; Calendar keeps its original re-export. */
export type StatedClockTime = { hour: number; minute: number };

export type StatedClockTimes =
  | { kind: "none" }
  | { kind: "one"; start: StatedClockTime; end?: StatedClockTime }
  | { kind: "several" };

const STATED_MERIDIEM_SOURCE = String.raw`(a\.?m\.?|p\.?m\.?)`;

export const STATED_CLOCK_MENTION_SOURCE = String.raw`\b(\d{1,2})(?::(\d{2}))?\s*${STATED_MERIDIEM_SOURCE}(?![a-z])|\b(noon|midnight)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*${STATED_MERIDIEM_SOURCE})`;

const STATED_CLOCK_MENTION_PATTERN = new RegExp(
  STATED_CLOCK_MENTION_SOURCE,
  "gi",
);

const STATED_CLOCK_RANGE_PATTERN = new RegExp(
  String.raw`\b(\d{1,2})(?::(\d{2}))?\s*${STATED_MERIDIEM_SOURCE}?\s*(?:-|–|—|until|till|through|to)\s*(\d{1,2})(?::(\d{2}))?\s*${STATED_MERIDIEM_SOURCE}(?![a-z])`,
  "i",
);

function clockFromStatedParts(
  hourRaw: string | undefined,
  minuteRaw: string | undefined,
  meridiem: string | undefined,
): StatedClockTime | null {
  if (hourRaw === undefined) return null;
  const hour = Number(hourRaw);
  const minute = minuteRaw === undefined ? 0 : Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (meridiem === undefined) {
    return hour >= 0 && hour <= 23 ? { hour, minute } : null;
  }
  if (hour < 1 || hour > 12) return null;
  const afternoon = meridiem.toLowerCase().startsWith("p");
  return { hour: (hour % 12) + (afternoon ? 12 : 0), minute };
}

export function parseStatedClockTimes(text: string): StatedClockTimes {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const range = STATED_CLOCK_RANGE_PATTERN.exec(normalized);
  let remainder = normalized;
  let start: StatedClockTime | undefined;
  let end: StatedClockTime | undefined;
  if (range) {
    const rangeStart = clockFromStatedParts(
      range[1],
      range[2],
      range[3] ?? range[6],
    );
    const rangeEnd = clockFromStatedParts(range[4], range[5], range[6]);
    if (!rangeStart || !rangeEnd) return { kind: "several" };
    start = rangeStart;
    end = rangeEnd;
    remainder = `${normalized.slice(0, range.index)} ${normalized.slice(
      range.index + range[0].length,
    )}`;
  }
  const mentions: StatedClockTime[] = [];
  for (const match of remainder.matchAll(STATED_CLOCK_MENTION_PATTERN)) {
    const mention =
      match[4] !== undefined
        ? { hour: match[4].toLowerCase() === "noon" ? 12 : 0, minute: 0 }
        : match[5] !== undefined
          ? clockFromStatedParts(match[5], match[6], undefined)
          : clockFromStatedParts(match[1], match[2], match[3]);
    if (!mention) return { kind: "several" };
    mentions.push(mention);
  }
  if (start) {
    return mentions.length > 0
      ? { kind: "several" }
      : { kind: "one", start, ...(end ? { end } : {}) };
  }
  const distinct = new Set(
    mentions.map((mention) => `${mention.hour}:${mention.minute}`),
  );
  const only = mentions[0];
  if (distinct.size === 0 || only === undefined) return { kind: "none" };
  if (distinct.size > 1) return { kind: "several" };
  return { kind: "one", start: only };
}
