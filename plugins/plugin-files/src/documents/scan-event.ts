/**
 * Poster and flyer event suggestions from locally recognized text (OCR). Nothing here reads an
 * image, calls a service or writes a calendar: the host shows every suggested field and every
 * inference for review, and its own calendar review and Save remain the only write. Ambiguous
 * numeric dates, conflicting dates or weekdays and time-zone abbreviations stay blank. Dates and
 * times without a reference instant stay strictly explicit; with one (the device clock and zone),
 * year-less and weekday dates, today/tomorrow and printed IANA or UTC-offset times are suggested
 * and disclosed. English text only.
 */
export type ScanEventRepeat = "none" | "daily" | "weekdays" | "weekly";
export type ScanEventFields = {
  title: string;
  date: string;
  time: string;
  minutes: number;
  location: string;
};
/** Reference instant and device zone for inference. Without it, suggestions stay strictly explicit. */
export type ScanEventContext = { now: Date; timeZone?: string };
/** Suggestions plus what was inferred. Every inference is disclosed; nothing here authorizes saving. */
export type ScanEventSuggestion = {
  fields: ScanEventFields;
  allDay: boolean;
  recurrence: {
    repeat: Exclude<ScanEventRepeat, "none">;
    evidence: string;
  } | null;
  sourceZone: string | null;
  disclosures: string[];
};
const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
function civilDate(
  year: number,
  month: number,
  day: number,
): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1970 ||
    year > 2100 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function clockTime(text: string): string | undefined {
  const clock = /^(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)$/i.exec(text);
  if (clock) {
    const hour = Number(clock[1]);
    if (hour < 1 || hour > 12) return;
    return `${String((hour % 12) + (/^p/i.test(clock[3]) ? 12 : 0)).padStart(2, "0")}:${clock[2] || "00"}`;
  }
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : undefined;
}
function timeWindow(
  text: string,
): { time: string; minutes?: number } | undefined {
  const single = clockTime(text);
  if (single) return { time: single };
  const range = text.split(/\s*(?:[-–—]|\s+to\s+)\s*/i);
  if (range.length !== 2) return;
  const start = clockTime(range[0].trim()),
    end = clockTime(range[1].trim());
  if (!start || !end) return;
  const minute = (clock: string) =>
    Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const minutes = minute(end) - minute(start);
  if (minutes < 15 || minutes > 1440) return;
  return { time: start, minutes };
}

// ---- Civil dates in a zone -------------------------------------------------
type Wall = { date: string; time: string };
function wallIn(instant: number, zone: string): Wall {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
/** Minutes east of UTC, for a fixed offset written as Z, UTC, GMT, UTC+2, GMT-05:00 or +02:00. */
function fixedOffset(text: string): number | undefined {
  const value = text.replace(/\s+/g, "");
  if (/^(?:Z|UTC|GMT)$/i.test(value)) return 0;
  const match = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?([0-5]\d))?$/i.exec(value);
  if (!match) return;
  const hours = Number(match[2]),
    minutes = Number(match[3] || 0);
  if (hours > 14 || (hours === 14 && minutes > 0)) return;
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}
type SourceZone = { label: string; offset?: number; iana?: string };
function parseZone(text: string): SourceZone | undefined {
  const trimmed = text
    .trim()
    .replace(/^\(|\)$/g, "")
    .trim();
  const offset = fixedOffset(trimmed);
  if (offset !== undefined)
    return {
      label: /^z$/i.test(trimmed)
        ? "UTC"
        : trimmed.replace(/\s+/g, "").toUpperCase(),
      offset,
    };
  if (
    /^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(trimmed) &&
    validZone(trimmed)
  )
    return { label: trimmed, iana: trimmed };
}
/** The exact instant of a wall time in a source zone; undefined when it does not exist or is ambiguous (clock changes). */
function sourceInstant(
  date: string,
  time: string,
  zone: SourceZone,
): number | undefined {
  const [y, m, d] = date.split("-").map(Number),
    [h, mi] = time.split(":").map(Number),
    base = Date.UTC(y, m - 1, d, h, mi);
  if (zone.offset !== undefined) return base - zone.offset * 60000;
  const iana = zone.iana;
  if (!iana) return undefined;
  const offsetAt = (instant: number) => {
    const wall = wallIn(instant, iana);
    const [wy, wm, wd] = wall.date.split("-").map(Number),
      [wh, wmi] = wall.time.split(":").map(Number);
    return Math.round(
      (Date.UTC(wy, wm - 1, wd, wh, wmi) -
        Math.floor(instant / 60000) * 60000) /
        60000,
    );
  };
  const candidates = new Set<number>();
  for (const offset of new Set([
    offsetAt(base - 86400000),
    offsetAt(base + 86400000),
    offsetAt(base),
  ])) {
    const instant = base - offset * 60000;
    const wall = wallIn(instant, iana);
    if (wall.date === date && wall.time === time) candidates.add(instant);
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

// ---- Zone evidence ----------------------------------------------------------
const abbreviation =
  /\b(?:[ECMP](?:[DS])?T|AK[DS]T|HST|CET|CEST|BST|IST|JST|KST|MSK)\b/i;
const ianaPattern =
  /\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc|US|Canada)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?/g;
const legacyZoned =
  /\b(?:UTC|GMT|[ECMP](?:[DS])?T|AK[DS]T|HST|CET|CEST|BST|IST|JST|KST|MSK|(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc|US|Canada)\/[A-Za-z_/-]+)\b|\btime\s*zone\s*:/i;
const isoZoned = /\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})\b/i;
/** Trailing zone written after a time on its line, e.g. "6 PM UTC+2", "18:30Z", "7 PM (America/New_York)". */
const trailingZone =
  /\s*(\(?\s*(?:Z|(?:UTC|GMT)(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?|[+-]\d{2}:?\d{2}|(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc|US|Canada)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\s*\)?)$/i;
type ZoneEvidence = { explicit: SourceZone[]; ambiguous: string[] };
function zoneEvidence(text: string, lines: string[]): ZoneEvidence {
  const explicit: SourceZone[] = [],
    ambiguous: string[] = [];
  for (const line of lines) {
    const label = /^time\s*zone\s*:\s*(.+)$/i.exec(line);
    if (label) {
      const zone = parseZone(label[1]);
      if (zone) explicit.push(zone);
      else ambiguous.push(label[1].trim().slice(0, 40));
      continue;
    }
    for (const match of line.matchAll(ianaPattern)) {
      const zone = parseZone(match[0]);
      if (zone) explicit.push(zone);
      else ambiguous.push(match[0]);
    }
    for (const match of line.matchAll(
      /\b(?:UTC|GMT)(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?(?![\w/])/gi,
    )) {
      const zone = parseZone(match[0]);
      if (zone) explicit.push(zone);
      else ambiguous.push(match[0]);
    }
    for (const match of line.matchAll(
      /\d{2}:\d{2}(?::\d{2})?(Z|[+-]\d{2}:?\d{2})\b/gi,
    )) {
      const zone = parseZone(match[1]);
      if (zone) explicit.push(zone);
      else ambiguous.push(match[1]);
    }
    for (const match of line.matchAll(
      /(?:\d|[ap]\.?m\.?)\s+([+-]\d{2}:?\d{2})\b/gi,
    )) {
      const zone = parseZone(match[1]);
      if (zone) explicit.push(zone);
      else ambiguous.push(match[1]);
    }
    const abbr = line
      .replace(/\b(?:UTC|GMT)\b/gi, "")
      .match(new RegExp(abbreviation.source, "gi"));
    if (abbr) ambiguous.push(...abbr);
  }
  if (!explicit.length && !ambiguous.length && legacyZoned.test(text))
    ambiguous.push("time zone");
  return { explicit, ambiguous };
}
const zoneKey = (zone: SourceZone) => zone.iana ?? `offset:${zone.offset}`;

// ---- Suggestions -------------------------------------------------------------
type DateCandidate = { value?: string; note?: string };
const monthPattern =
  "(" +
  months
    .map((month) =>
      month === "september"
        ? "sep(?:t(?:ember)?)?"
        : month.length === 3
          ? month
          : `${month.slice(0, 3)}(?:${month.slice(3)})?`,
    )
    .join("|") +
  ")\\.?";
const monthIndex = (name: string) =>
  months.findIndex((month) => month.startsWith(name.toLowerCase())) + 1;
function nextOccurrence(
  month: number,
  day: number,
  today: string,
): string | undefined {
  const year = Number(today.slice(0, 4));
  for (let candidate = year; candidate <= year + 8; candidate++) {
    const date = civilDate(candidate, month, day);
    if (date && date >= today) return date;
  }
}
function recurrenceHint(
  text: string,
  disclosures: string[],
): ScanEventSuggestion["recurrence"] {
  const found = new Map<Exclude<ScanEventRepeat, "none">, string>();
  const add = (
    repeat: Exclude<ScanEventRepeat, "none">,
    match: RegExpExecArray | null,
  ) => {
    if (match && !found.has(repeat)) found.set(repeat, match[0].trim());
  };
  add(
    "weekdays",
    /\b(?:every|each)\s+weekday\b|\bweekdays\b|\bmon(?:day)?s?\s*(?:-|–|—|to|through|thru)\s*fri(?:day)?s?\b/i.exec(
      text,
    ),
  );
  if (!found.has("weekdays"))
    add(
      "daily",
      /\b(?:every|each)\s+(?:day|morning|evening|night)\b|\bdaily\b|\bnightly\b/i.exec(
        text,
      ),
    );
  if (!found.has("weekdays"))
    add(
      "weekly",
      new RegExp(
        "\\b(?:every|each)\\s+(?:week|" +
          weekdays.join("|") +
          ")\\b|\\bweekly\\b|\\b(?:" +
          weekdays.join("|") +
          ")s\\b",
        "i",
      ).exec(text),
    );
  const unsupported =
    /\b(?:every|each)\s+(?:other\s+\w+|month|year|\d+(?:st|nd|rd|th)?\s+\w+)\b|\b(?:monthly|annually|yearly|biweekly|fortnightly)\b/i.exec(
      text,
    );
  if (unsupported)
    disclosures.push(
      `Repeat “${unsupported[0].trim()}” is not a repeat this draft supports. Add it in Calendar if you need it.`,
    );
  if (found.size > 1) {
    disclosures.push(
      "Conflicting repeat wording was found. No repeat is suggested.",
    );
    return null;
  }
  if (unsupported || !found.size) return null;
  const [repeat, evidence] = [...found][0];
  disclosures.push(
    `Repeat ${repeat === "weekdays" ? "on weekdays" : repeat} suggested from “${evidence}”. It is off until you turn it on.`,
  );
  return { repeat, evidence };
}

/** Explicit civil suggestions only: no invented year, locale order or time zone. */
export function suggestScanEvent(text: string): ScanEventFields {
  return analyze(text).fields;
}

/**
 * Suggestions with an injected reference instant. Year-less and weekday dates
 * become their next occurrence, "today"/"tomorrow" resolve against `now`,
 * explicit IANA or UTC-offset times convert into the device zone, a dated poster
 * with no time is suggested all-day and repeat wording becomes an opt-in hint.
 * Ambiguous numeric dates and zone abbreviations stay blank. Every inference is
 * listed in `disclosures`; saving still requires Calendar review.
 */
export function suggestScanEventDetails(
  text: string,
  context: ScanEventContext,
): ScanEventSuggestion {
  return analyze(text, context);
}

function analyze(
  text: string,
  context?: ScanEventContext,
): ScanEventSuggestion {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const disclosures: string[] = [];
  const target = context
    ? context.timeZone && validZone(context.timeZone)
      ? context.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone
    : "";
  const today = context ? wallIn(context.now.getTime(), target).date : "";
  const dates: DateCandidate[] = [];
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})(?=T\d|\b)/g))
    dates.push({
      value: civilDate(Number(match[1]), Number(match[2]), Number(match[3])),
    });
  const yearless = (month: number, day: number, source: string) => {
    if (!context) {
      dates.push({});
      return;
    }
    const value = nextOccurrence(month, day, today);
    dates.push(
      value
        ? {
            value,
            note: `Year inferred: “${source.trim()}” has no year, so the next occurrence (${value}) is suggested.`,
          }
        : {},
    );
  };
  for (const match of text.matchAll(
    new RegExp(
      "\\b" +
        monthPattern +
        "[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?(?:,?[ \\t]+(\\d{4}))?\\b",
      "gi",
    ),
  )) {
    if (match[3])
      dates.push({
        value: civilDate(
          Number(match[3]),
          monthIndex(match[1]),
          Number(match[2]),
        ),
      });
    else yearless(monthIndex(match[1]), Number(match[2]), match[0]);
  }
  for (const match of text.matchAll(
    new RegExp(
      "\\b(\\d{1,2})(?:st|nd|rd|th)?[ \\t]+" +
        monthPattern +
        "(?:,?[ \\t]+(\\d{4}))?\\b",
      "gi",
    ),
  )) {
    if (match[3])
      dates.push({
        value: civilDate(
          Number(match[3]),
          monthIndex(match[2]),
          Number(match[1]),
        ),
      });
    else yearless(monthIndex(match[2]), Number(match[1]), match[0]);
  }
  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(text)) {
    dates.push({});
    if (context)
      disclosures.push(
        "A numeric date such as 10/11 can mean different days in different regions. Enter the date yourself.",
      );
  }
  if (context) {
    if (/\b(?:today|tonight)\b/i.test(text))
      dates.push({
        value: today,
        note: `“Today” read as ${today} from when you opened this review.`,
      });
    if (/\btomorrow\b/i.test(text)) {
      const value = addDays(today, 1);
      dates.push({
        value,
        note: `“Tomorrow” read as ${value} from when you opened this review.`,
      });
    }
  }
  // Weekday names: a check on a calendar date, or the next occurrence when no date is printed.
  const named = context
    ? [
        ...text.matchAll(
          new RegExp(
            "\\b(" +
              weekdays.join("|") +
              ")(s)?\\b|\\b(sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\\.?(?=[ \\t]*,)",
            "gi",
          ),
        ),
      ].map((match) => ({
        day: weekdays.findIndex((day) =>
          day.startsWith((match[1] || match[3]).toLowerCase().slice(0, 3)),
        ),
        source: match[0],
      }))
    : [];
  let calendarDates = dates.filter(
      (candidate) => candidate.value !== undefined,
    ),
    known =
      dates.length > 0 &&
      !dates.some((candidate) => candidate.value === undefined) &&
      new Set(calendarDates.map((c) => c.value)).size === 1;
  if (context && named.length) {
    const days = new Set(named.map((n) => n.day));
    if (days.size > 1) {
      dates.push({});
      known = false;
      disclosures.push(
        "Different weekdays are printed. Enter the date yourself.",
      );
    } else if (known) {
      if (weekdayOf(calendarDates[0].value ?? "") !== named[0].day) {
        dates.push({});
        known = false;
        disclosures.push(
          `“${named[0].source}” does not match the printed date. Enter the date yourself.`,
        );
      }
    } else if (!dates.length) {
      let value = today;
      while (weekdayOf(value) !== named[0].day) value = addDays(value, 1);
      dates.push({
        value,
        note: `“${named[0].source}” read as its next occurrence, ${value}${value === today ? " (today)" : ""}.`,
      });
      calendarDates = dates;
      known = true;
    }
  }
  const dateClear = known;
  if (dateClear)
    for (const note of new Set(
      dates.map((d) => d.note).filter((n): n is string => !!n),
    ))
      disclosures.push(note);
  const zones = context
    ? zoneEvidence(text, lines)
    : { explicit: [], ambiguous: [] };
  const zoned = legacyZoned.test(text) || isoZoned.test(text);
  const timeLines = lines
    .map((line) =>
      line.replace(
        /^(?:\d{4}-\d{2}-\d{2}[T ]+)?(?:at\s+|time:\s*|starts?:\s*)?/i,
        "",
      ),
    )
    .map((line) =>
      context
        ? line
            .replace(trailingZone, "")
            .replace(
              new RegExp(`\\s*\\(?\\s*${abbreviation.source}\\s*\\)?$`, "i"),
              "",
            )
        : line,
    )
    .filter((line) => /^\d{1,2}(?::|\s*[ap]\.?m)/i.test(line));
  const windows = timeLines.map(timeWindow);
  const times = windows.map((value) => value?.time),
    durations = windows.flatMap((value) =>
      value?.minutes === undefined ? [] : [value.minutes],
    );
  const timeConsistent =
    (dates.length === 0 || dateClear) &&
    times.length > 0 &&
    !times.includes(undefined) &&
    new Set(times).size === 1 &&
    new Set(durations).size <= 1;
  let date = dateClear ? (calendarDates[0].value ?? "") : "",
    time = "",
    sourceZone: string | null = null;
  if (!context) time = !zoned && timeConsistent ? (times[0] ?? "") : "";
  else if (timeConsistent) {
    const explicit = [
      ...new Map(zones.explicit.map((zone) => [zoneKey(zone), zone])).values(),
    ];
    if (zones.ambiguous.length)
      disclosures.push(
        `Time zone “${zones.ambiguous[0]}” is ambiguous. Enter the local start time yourself.`,
      );
    else if (explicit.length > 1)
      disclosures.push(
        "More than one time zone is printed. Enter the local start time yourself.",
      );
    else if (explicit.length === 1) {
      const zone = explicit[0];
      if (!dateClear)
        disclosures.push(
          `The time is in ${zone.label}, but without a date it cannot be converted. Enter the local start time yourself.`,
        );
      else {
        const instant = sourceInstant(date, times[0] ?? "", zone);
        if (instant === undefined)
          disclosures.push(
            `${times[0]} on ${date} does not exist or occurs twice in ${zone.label} because the clocks change. Enter the local start time yourself.`,
          );
        else {
          const local = wallIn(instant, target);
          sourceZone = zone.label;
          disclosures.push(
            `Converted from ${times[0]} ${zone.label} on ${date} to ${local.time} on ${local.date} in your time zone (${target}). Check the source zone on the photo.`,
          );
          date = local.date;
          time = local.time;
        }
      }
    } else time = times[0] ?? "";
  }
  const timeClear = time !== "";
  const timeLike =
    /\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?(?![a-z])|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight)\b|\bat\s+\d/i.test(
      text,
    );
  // A printed time left blank for another reason (e.g. an unclear date) still names an ambiguous zone.
  const zoneNote = zones.ambiguous.length
    ? `Time zone “${zones.ambiguous[0]}” is ambiguous. Enter the local start time yourself.`
    : "";
  if (
    context &&
    !timeClear &&
    timeLike &&
    zoneNote &&
    !disclosures.includes(zoneNote)
  )
    disclosures.push(zoneNote);
  const allDay = !!context && dateClear && !timeLike && !timeLines.length;
  if (allDay)
    disclosures.push("No time is printed, so an all-day event is suggested.");
  const recurrence = context ? recurrenceHint(text, disclosures) : null;
  const locations = lines
    .map((line) => /^(?:location|venue):\s*(.+)$/i.exec(line)?.[1].trim())
    .filter((value): value is string => !!value);
  return {
    fields: {
      title: (lines[0] || "").slice(0, 200),
      date,
      time,
      minutes: timeClear && durations.length ? durations[0] : 60,
      location:
        new Set(locations).size === 1 && locations[0].length <= 500
          ? locations[0]
          : "",
    },
    allDay,
    recurrence,
    sourceZone,
    disclosures,
  };
}

/**
 * Reviewed fields of a scanned event after validation: civil date, local start and duration (or
 * all day), repeat, and the exact reviewed text as notes. Provider-neutral; a host maps it to its
 * own calendar draft and keeps its own review and Save as the only write.
 */
export type ScanEventProposal = {
  title: string;
  location: string;
  notes: string;
  repeat: ScanEventRepeat;
  /** Civil date, YYYY-MM-DD. */
  date: string;
  /** Whole days from `now`'s local civil date to `date`. */
  dayOffset: number;
  allDay: boolean;
  /** Local wall time HH:MM; absent when all day. */
  time?: string;
  /** Duration in minutes, 15–1440; absent when all day. */
  minutes?: number;
};
const repeats: readonly ScanEventRepeat[] = [
  "none",
  "daily",
  "weekdays",
  "weekly",
];
function reviewedCommon(
  fields: Pick<ScanEventFields, "title" | "date" | "location"> & {
    repeat?: ScanEventRepeat;
  },
  text: string,
  now: Date,
) {
  if (text.length > 16000)
    throw Error(
      "Event notes support up to 16,000 characters. Shorten the scanned text before creating an event draft.",
    );
  if (
    !fields.title.trim() ||
    fields.title.length > 200 ||
    fields.location.length > 500
  )
    throw Error(
      "Enter a title up to 200 characters and a location up to 500 characters.",
    );
  const repeat = fields.repeat ?? "none";
  if (!repeats.includes(repeat)) throw Error("Choose a supported repeat.");
  return { repeat, now };
}
function civil(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1970 || year > 2100)
    throw Error("Choose a year from 1970 through 2100.");
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  )
    throw Error("Choose a valid date.");
  return { year, month, day, value };
}
const dayOffset = (civilDay: Date, now: Date) =>
  (civilDay.getTime() -
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
  86400000;

/**
 * Validates reviewed all-day fields: one civil day, no time. It never saves; the host's calendar
 * review and Save write it as an all-day event.
 */
export function reviewScanAllDayEvent(
  fields: Pick<ScanEventFields, "title" | "date" | "location"> & {
    repeat?: ScanEventRepeat;
  },
  text: string,
  now = new Date(),
): ScanEventProposal {
  const { repeat } = reviewedCommon(fields, text, now);
  if (!/^(\d{4})-(\d{2})-(\d{2})$/.test(fields.date))
    throw Error("Choose the event date.");
  const day = civil(fields.date);
  if (!day) throw Error("Choose the event date.");
  return {
    title: fields.title.trim(),
    location: fields.location.trim(),
    notes: text,
    repeat,
    date: fields.date,
    dayOffset: dayOffset(day.value, now),
    allDay: true,
  };
}

/**
 * Validates reviewed timed fields. The local start must exist in the device zone (not skipped by
 * a clock change). It never saves; the host's calendar review and Save remain the only write.
 */
export function reviewScanEvent(
  fields: ScanEventFields & { allDay?: boolean; repeat?: ScanEventRepeat },
  text: string,
  now = new Date(),
): ScanEventProposal {
  const { repeat } = reviewedCommon(fields, text, now);
  if (fields.allDay)
    throw Error(
      "Calendar drafts from a scan need a start time. Enter a start time and duration, or create the all-day event in Calendar.",
    );
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fields.date),
    time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(fields.time);
  if (!date || !time) throw Error("Choose the event date and start time.");
  const day = civil(fields.date);
  if (!day) throw Error("Choose the event date and start time.");
  if (
    !Number.isInteger(fields.minutes) ||
    fields.minutes < 15 ||
    fields.minutes > 1440
  )
    throw Error("Choose a duration from 15 to 1440 minutes.");
  const hour = Number(time[1]),
    minute = Number(time[2]),
    local = new Date(day.year, day.month - 1, day.day, hour, minute);
  if (
    local.getFullYear() !== day.year ||
    local.getMonth() !== day.month - 1 ||
    local.getDate() !== day.day ||
    local.getHours() !== hour ||
    local.getMinutes() !== minute
  )
    throw Error(
      "That local time does not exist because the clocks change. Choose another time.",
    );
  return {
    title: fields.title.trim(),
    location: fields.location.trim(),
    notes: text,
    repeat,
    date: fields.date,
    dayOffset: dayOffset(day.value, now),
    allDay: false,
    time: fields.time,
    minutes: fields.minutes,
  };
}
