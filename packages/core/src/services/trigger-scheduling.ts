/**
 * Trigger scheduling math: parses 5-field cron expressions (with `N/step`,
 * range, list, and the Sunday-as-7 alias), computes the next matching run time
 * in a given timezone (honoring POSIX day-of-month/day-of-week OR-semantics and
 * DST fall-back dedupe), and resolves interval/once/cron/event triggers to
 * their next-run timing. Cron parsing returns null on malformed input; interval
 * values are clamped to [MIN, MAX]_TRIGGER_INTERVAL_MS.
 */
import type { TriggerConfig, TriggerType } from "../types/trigger";

export const MIN_TRIGGER_INTERVAL_MS = 60_000;
export const MAX_TRIGGER_INTERVAL_MS = 31 * 24 * 60 * 60 * 1000;
export const DISABLED_TRIGGER_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

const CRON_FIELDS = 5;
// A leap-day schedule can be eight years apart across a non-leap century.
const CRON_SCAN_WINDOW_MS = 8 * 366 * 24 * 60 * 60 * 1000;
const CRON_DAY_MS = 24 * 60 * 60 * 1000;
const CRON_MINUTE_MS = 60_000;
const CRON_HOUR_MS = 60 * CRON_MINUTE_MS;
// The largest DST gap in use is two hours; look back past it.
const CRON_SPRING_FORWARD_LOOKBACK_MS = 3 * CRON_HOUR_MS;
const CRON_FALLBACK_LOOKBACKS_MS = [
	30 * CRON_MINUTE_MS,
	CRON_HOUR_MS,
	2 * CRON_HOUR_MS,
	3 * CRON_HOUR_MS,
] as const;
/** Max timestamp a JS Date can represent (±8.64e15 ms); beyond this a Date is Invalid. */
const MAX_REPRESENTABLE_MS = 8_640_000_000_000_000;

interface CronRange {
	min: number;
	max: number;
	/**
	 * POSIX/Vixie cron accepts `7` as an alias for Sunday (`0`) in the
	 * day-of-week field. LLMs commonly emit `7`, so where this is set the
	 * parser accepts `7` (single, range end, or step) and folds it onto `0`.
	 */
	sundayIsSeven?: boolean;
}

interface CronSchedule {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
	/**
	 * Standard (POSIX/Vixie) cron day semantics: when BOTH day-of-month and
	 * day-of-week are restricted (the field does not start with `*`), a
	 * candidate matches when EITHER field matches; otherwise both must match.
	 * `0 0 13 * 5` therefore fires on every 13th AND every Friday — not only
	 * on Friday-the-13th.
	 */
	dayOfMonthRestricted: boolean;
	dayOfWeekRestricted: boolean;
}

const CRON_RANGES: readonly CronRange[] = [
	{ min: 0, max: 59 },
	{ min: 0, max: 23 },
	{ min: 1, max: 31 },
	{ min: 1, max: 12 },
	{ min: 0, max: 6, sundayIsSeven: true },
];

function parseInteger(raw: string): number | null {
	if (!/^-?\d+$/.test(raw)) return null;
	const value = Number(raw);
	if (!Number.isFinite(value)) return null;
	return value;
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function parseCronPart(part: string, range: CronRange): Set<number> | null {
	const output = new Set<number>();
	const chunks = part.split(",");

	// `7` is a legal Sunday alias in the day-of-week field. Accept it up to
	// `max + 1` during bounds checks and fold it back onto `min` (0) on insert,
	// so `7`, `5-7`, and `7/step` all resolve to Sunday without duplicating a
	// day. For every other field `foldValue` is the identity.
	const upperBound = range.sundayIsSeven ? range.max + 1 : range.max;
	const foldValue = (value: number): number =>
		range.sundayIsSeven && value === range.max + 1 ? range.min : value;

	for (const chunkRaw of chunks) {
		const chunk = chunkRaw.trim();
		if (!chunk) return null;

		const stepParts = chunk.split("/");
		if (stepParts.length > 2) return null;

		const step = stepParts.length === 2 ? parseInteger(stepParts[1].trim()) : 1;
		if (step === null || step <= 0) return null;

		const base = stepParts[0].trim();
		if (base === "*") {
			for (let value = range.min; value <= range.max; value += step) {
				output.add(value);
			}
			continue;
		}

		const rangeParts = base.split("-");
		if (rangeParts.length === 1) {
			const single = parseInteger(rangeParts[0].trim());
			if (single === null) return null;
			if (single < range.min || single > upperBound) return null;
			// `N/step` (e.g. `5/15`) means "from N to the range max, stepping by
			// step" — standard cron. Without a step it is just the single value.
			const upper = stepParts.length === 2 ? upperBound : single;
			for (let value = single; value <= upper; value += step) {
				output.add(foldValue(value));
			}
			continue;
		}

		if (rangeParts.length !== 2) return null;
		const start = parseInteger(rangeParts[0].trim());
		const end = parseInteger(rangeParts[1].trim());
		if (start === null || end === null) return null;
		if (start > end) return null;
		if (start < range.min || end > upperBound) return null;
		for (let value = start; value <= end; value += step) {
			output.add(foldValue(value));
		}
	}

	return output.size > 0 ? output : null;
}

export function normalizeTriggerIntervalMs(intervalMs: number): number {
	if (!Number.isFinite(intervalMs)) return MIN_TRIGGER_INTERVAL_MS;
	const rounded = Math.floor(intervalMs);
	return clamp(rounded, MIN_TRIGGER_INTERVAL_MS, MAX_TRIGGER_INTERVAL_MS);
}

export function parseCronExpression(expression: string): CronSchedule | null {
	const trimmed = expression.trim();
	if (!trimmed) return null;
	const parts = trimmed.split(/\s+/);
	if (parts.length !== CRON_FIELDS) return null;

	const minute = parseCronPart(parts[0], CRON_RANGES[0]);
	const hour = parseCronPart(parts[1], CRON_RANGES[1]);
	const dayOfMonth = parseCronPart(parts[2], CRON_RANGES[2]);
	const month = parseCronPart(parts[3], CRON_RANGES[3]);
	const dayOfWeek = parseCronPart(parts[4], CRON_RANGES[4]);

	if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
		return null;
	}

	return {
		minute,
		hour,
		dayOfMonth,
		month,
		dayOfWeek,
		// Vixie-cron rule: a day field counts as "restricted" for the dom/dow
		// OR-semantics only when it does not start with `*` (`*` and `*/n` are
		// unrestricted).
		dayOfMonthRestricted: !parts[2].trim().startsWith("*"),
		dayOfWeekRestricted: !parts[4].trim().startsWith("*"),
	};
}

function cronDateMatchesUTC(schedule: CronSchedule, candidate: Date): boolean {
	const dayOfMonthMatches = schedule.dayOfMonth.has(candidate.getUTCDate());
	const dayOfWeekMatches = schedule.dayOfWeek.has(candidate.getUTCDay());
	// POSIX/Vixie cron: when BOTH day fields are restricted, a day matching
	// EITHER one fires; otherwise both must match (an unrestricted `*` field
	// always matches anyway).
	const dayMatches =
		schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted
			? dayOfMonthMatches || dayOfWeekMatches
			: dayOfMonthMatches && dayOfWeekMatches;
	return dayMatches && schedule.month.has(candidate.getUTCMonth() + 1);
}

function cronMatchesUTC(schedule: CronSchedule, candidateMs: number): boolean {
	const candidate = new Date(candidateMs);
	return (
		schedule.minute.has(candidate.getUTCMinutes()) &&
		schedule.hour.has(candidate.getUTCHours()) &&
		cronDateMatchesUTC(schedule, candidate)
	);
}

function buildTzFormatter(timezone: string): Intl.DateTimeFormat | null {
	try {
		return new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	} catch {
		// error-policy:J3 timezone names are untrusted schedule input; an invalid
		// identifier is an explicit formatter-construction miss.
		return null;
	}
}

/**
 * UTC timestamp from calendar parts — uses setUTCFullYear so years 0-99 keep
 * their literal meaning (0000, 0005 … 0099) instead of Date.UTC's 1900-1999
 * remapping. Exported for behavioral regression coverage; internal callers
 * should prefer this over raw Date.UTC(y,m,d) when the year is dynamic.
 */
export function utcDateMs(
	year: number,
	monthIndex: number,
	day: number,
	hour = 0,
	minute = 0,
	second = 0,
	ms = 0,
): number {
	const d = new Date(0);
	d.setUTCFullYear(year, monthIndex, day);
	d.setUTCHours(hour, minute, second, ms);
	return d.getTime();
}

function offsetMsFromFormatter(
	formatter: Intl.DateTimeFormat,
	atMs: number,
): number {
	const parts = formatter.formatToParts(new Date(atMs));
	const get = (type: string): number => {
		const part = parts.find((p) => p.type === type);
		return part ? Number(part.value) : 0;
	};
	const tzDate = utcDateMs(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	return tzDate - atMs;
}

function cronMatches(
	schedule: CronSchedule,
	candidateMs: number,
	timezone: string | undefined,
	formatter: Intl.DateTimeFormat | null,
): boolean {
	if (!timezone || timezone === "UTC" || !formatter) {
		return cronMatchesUTC(schedule, candidateMs);
	}
	const candidateOffset = offsetMsFromFormatter(formatter, candidateMs);
	const wallMs = candidateMs + candidateOffset;
	if (!cronMatchesUTC(schedule, wallMs)) {
		// DST spring-forward skips the wall times between the old and new
		// offset. A skipped time the schedule names runs one gap later
		// (02:30 -> 03:30 for a one-hour gap), as
		// resolveScheduledAtIsoInTimeZone and Date.parse read a skipped local
		// time, instead of not running that day. The candidate is in the first
		// gap-length span after the transition when the offset one gap earlier
		// is still the old offset. No state is carried between candidates, so
		// the whole-day skip in computeNextCronRunAtMs stays correct.
		const priorOffset = offsetMsFromFormatter(
			formatter,
			candidateMs - CRON_SPRING_FORWARD_LOOKBACK_MS,
		);
		if (priorOffset >= candidateOffset) return false;
		const gapMs = candidateOffset - priorOffset;
		return (
			offsetMsFromFormatter(formatter, candidateMs - gapMs) === priorOffset &&
			cronMatchesUTC(schedule, candidateMs + priorOffset)
		);
	}
	// DST fall-back: an ambiguous local time repeats. Fire only the FIRST
	// instant, matching common cron implementations. The repeated span is not
	// always one hour (Australia/Lord_Howe falls back by 30 minutes), so derive
	// the actual offset delta and reject candidates whose wall-clock already
	// existed at candidate-delta.
	for (const lookbackMs of CRON_FALLBACK_LOOKBACKS_MS) {
		const priorOffset = offsetMsFromFormatter(
			formatter,
			candidateMs - lookbackMs,
		);
		if (priorOffset <= candidateOffset) continue;
		const offsetDelta = priorOffset - candidateOffset;
		const priorSameWallMs = candidateMs - offsetDelta;
		const priorWallMs =
			priorSameWallMs + offsetMsFromFormatter(formatter, priorSameWallMs);
		if (wallMs === priorWallMs) return false;
	}
	return true;
}

export function computeNextCronRunAtMs(
	expression: string,
	fromMs: number,
	timezone?: string,
): number | null {
	const schedule = parseCronExpression(expression);
	if (!schedule) return null;
	// Do not scan forward from a base at or above the maximum Date value.
	if (!Number.isFinite(fromMs) || fromMs >= MAX_REPRESENTABLE_MS) return null;

	const start = Math.floor(fromMs / CRON_MINUTE_MS) * CRON_MINUTE_MS;
	// Cap the window at the max representable Date so a base near the ceiling
	// scans only the representable remainder.
	const cutoff = Math.min(start + CRON_SCAN_WINDOW_MS, MAX_REPRESENTABLE_MS);
	// Reuse one formatter for the complete scan.
	const formatter =
		timezone && timezone !== "UTC" ? buildTzFormatter(timezone) : null;
	let checkedDay = Number.NaN;
	let dayCanMatch = false;

	for (
		let candidate = start + CRON_MINUTE_MS;
		candidate <= cutoff;
		candidate += CRON_MINUTE_MS
	) {
		const day = Math.floor(candidate / CRON_DAY_MS) * CRON_DAY_MS;
		if (day !== checkedDay) {
			checkedDay = day;
			// A zone's local date can be the previous or next UTC date. Only
			// skip a whole UTC day when none of those dates can match.
			dayCanMatch = (formatter ? [-1, 0, 1] : [0]).some((offset) =>
				cronDateMatchesUTC(schedule, new Date(day + offset * CRON_DAY_MS)),
			);
		}
		if (!dayCanMatch) {
			candidate = day + CRON_DAY_MS - CRON_MINUTE_MS;
			continue;
		}
		if (cronMatches(schedule, candidate, timezone, formatter)) {
			return candidate;
		}
	}

	return null;
}

const OFFSETLESS_ISO_DATE_TIME =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * Pin an ISO date-time that carries no `Z` or UTC offset to an absolute
 * instant by reading its wall-clock time in `timezone`. `Date.parse` reads
 * such a value in the host process zone, which is not the user's zone on a
 * cloud or container host. Values that already carry an offset, date-only
 * values and anything else are returned unchanged for `parseScheduledAtIso`.
 */
export function resolveScheduledAtIsoInTimeZone(
	scheduledAtIso: string,
	timezone: string,
): string {
	const trimmed = scheduledAtIso.trim();
	if (!OFFSETLESS_ISO_DATE_TIME.test(trimmed)) return scheduledAtIso;
	const wallMs = Date.parse(`${trimmed}Z`);
	if (!Number.isFinite(wallMs)) return scheduledAtIso;
	const formatter = buildTzFormatter(timezone);
	if (!formatter) {
		throw new RangeError(`Invalid time zone: ${timezone}`);
	}
	// The formatter reads whole seconds, so offsets are taken at the whole
	// second and the fraction is added back at the end.
	const fractionMs = wallMs % 1000;
	const wallSecondMs = wallMs - fractionMs;
	const offsetAt = (atMs: number) => offsetMsFromFormatter(formatter, atMs);
	// The zone's offsets a day either side bracket any DST transition near the
	// wall clock. They give two candidate instants, which are equal away from
	// a transition.
	const dayMs = 24 * 60 * 60 * 1000;
	const offsetBefore = offsetAt(wallSecondMs - dayMs);
	const offsetAfter = offsetAt(wallSecondMs + dayMs);
	const early = wallSecondMs - offsetBefore;
	const late = wallSecondMs - offsetAfter;
	// A candidate is real when the zone has its offset at that instant. Keep
	// `early` unless only `late` is real. That reads a repeated hour as its
	// first pass and a skipped hour forward, as `Date.parse` does for local
	// times.
	const instantMs =
		offsetAt(early) !== offsetBefore && offsetAt(late) === offsetAfter
			? late
			: early;
	return new Date(instantMs + fractionMs).toISOString();
}

export function parseScheduledAtIso(scheduledAtIso: string): number | null {
	const timestamp = Date.parse(scheduledAtIso);
	if (!Number.isFinite(timestamp)) return null;
	return timestamp;
}

export interface TriggerTiming {
	updatedAt: number;
	updateIntervalMs: number;
	nextRunAtMs: number;
}

function resolveIntervalTiming(
	trigger: TriggerConfig,
	nowMs: number,
): TriggerTiming {
	const interval = normalizeTriggerIntervalMs(trigger.intervalMs ?? 0);
	return {
		updatedAt: nowMs,
		updateIntervalMs: interval,
		nextRunAtMs: nowMs + interval,
	};
}

function resolveOnceTiming(
	trigger: TriggerConfig,
	nowMs: number,
): TriggerTiming | null {
	if (!trigger.scheduledAtIso) return null;
	const scheduledAt = parseScheduledAtIso(trigger.scheduledAtIso);
	if (scheduledAt === null) return null;

	const nextRunAtMs = Math.max(scheduledAt, nowMs);
	return {
		updatedAt: nowMs,
		updateIntervalMs: Math.max(0, nextRunAtMs - nowMs),
		nextRunAtMs,
	};
}

function resolveCronTiming(
	trigger: TriggerConfig,
	nowMs: number,
): TriggerTiming | null {
	if (!trigger.cronExpression) return null;
	const nextRunAtMs = computeNextCronRunAtMs(
		trigger.cronExpression,
		nowMs,
		trigger.timezone,
	);
	if (nextRunAtMs === null) return null;
	return {
		updatedAt: nowMs,
		updateIntervalMs: Math.max(0, nextRunAtMs - nowMs),
		nextRunAtMs,
	};
}

function resolveEventTiming(nowMs: number): TriggerTiming {
	return {
		updatedAt: nowMs,
		updateIntervalMs: DISABLED_TRIGGER_INTERVAL_MS,
		nextRunAtMs: nowMs + DISABLED_TRIGGER_INTERVAL_MS,
	};
}

export function resolveTriggerTiming(
	trigger: TriggerConfig,
	nowMs: number,
): TriggerTiming | null {
	if (!trigger.enabled) return null;
	switch (trigger.triggerType) {
		case "interval":
			return resolveIntervalTiming(trigger, nowMs);
		case "once":
			return resolveOnceTiming(trigger, nowMs);
		case "cron":
			return resolveCronTiming(trigger, nowMs);
		case "event":
			return resolveEventTiming(nowMs);
		default: {
			const exhaustiveCheck: TriggerType = trigger.triggerType;
			throw new Error(`Unsupported trigger type: ${exhaustiveCheck}`);
		}
	}
}

/**
 * Powered-on scheduling. A host whose agent runs only while its device is
 * powered on (a phone-resident agent) sets this setting to `record`. A
 * scheduled occurrence that passed while the agent was not running is then
 * recorded once as missed and never run late, and the next occurrence is
 * armed as usual. A delay while the agent was running (device doze, a busy
 * scheduler) is not a missed occurrence: that occurrence still runs. Hosts
 * without the setting keep running a late occurrence.
 */
export const MISSED_SCHEDULED_OCCURRENCES_SETTING =
	"ELIZA_MISSED_SCHEDULED_OCCURRENCES";
/** Lateness tolerated before an occurrence can be missed (resident digests use the same window). */
export const SCHEDULED_OCCURRENCE_WINDOW_MS = 120_000;
export const MISSED_SCHEDULED_OCCURRENCE_TEXT =
	"The scheduled time passed while the agent was not running. This occurrence did not run, and no backlog is executed.";

/**
 * Whether this host selected the powered-on policy: the runtime setting wins,
 * then the process environment (the native runtime profile sets it there).
 */
export function recordsMissedScheduledOccurrences(
	runtime?: { getSetting?(key: string): unknown } | null,
): boolean {
	// Partial runtimes (tests, narrow hosts) may not expose settings.
	const configured =
		typeof runtime?.getSetting === "function"
			? runtime.getSetting(MISSED_SCHEDULED_OCCURRENCES_SETTING)
			: undefined;
	const value =
		typeof configured === "string"
			? configured
			: typeof process !== "undefined"
				? process.env?.[MISSED_SCHEDULED_OCCURRENCES_SETTING]
				: undefined;
	return value === "record";
}

/** Wall-clock instant at which this agent process started. */
export function agentProcessStartedAtMs(nowMs: number = Date.now()): number {
	const uptime =
		typeof process !== "undefined" && typeof process.uptime === "function"
			? process.uptime()
			: 0;
	return nowMs - Math.round(uptime * 1000);
}

/**
 * True when a scheduled occurrence is reached outside its window and its
 * scheduled instant precedes the start of the agent process, so the agent was
 * not running when it came due.
 */
export function isMissedScheduledOccurrence(
	scheduledAtMs: number,
	nowMs: number,
	agentStartedAtMs: number = agentProcessStartedAtMs(nowMs),
): boolean {
	return (
		nowMs - scheduledAtMs > SCHEDULED_OCCURRENCE_WINDOW_MS &&
		scheduledAtMs < agentStartedAtMs
	);
}
