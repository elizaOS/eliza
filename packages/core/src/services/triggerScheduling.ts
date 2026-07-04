import type { TriggerConfig, TriggerType } from "../types/trigger";

export const MIN_TRIGGER_INTERVAL_MS = 60_000;
export const MAX_TRIGGER_INTERVAL_MS = 31 * 24 * 60 * 60 * 1000;
export const DISABLED_TRIGGER_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

const CRON_FIELDS = 5;
const CRON_SCAN_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const CRON_MINUTE_MS = 60_000;
const CRON_HOUR_MS = 60 * CRON_MINUTE_MS;
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

function cronMatchesUTC(schedule: CronSchedule, candidateMs: number): boolean {
	const candidate = new Date(candidateMs);
	const dayOfMonthMatches = schedule.dayOfMonth.has(candidate.getUTCDate());
	const dayOfWeekMatches = schedule.dayOfWeek.has(candidate.getUTCDay());
	// POSIX/Vixie cron: when BOTH day fields are restricted, a day matching
	// EITHER one fires; otherwise both must match (an unrestricted `*` field
	// always matches anyway).
	const dayMatches =
		schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted
			? dayOfMonthMatches || dayOfWeekMatches
			: dayOfMonthMatches && dayOfWeekMatches;
	return (
		schedule.minute.has(candidate.getUTCMinutes()) &&
		schedule.hour.has(candidate.getUTCHours()) &&
		dayMatches &&
		schedule.month.has(candidate.getUTCMonth() + 1)
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
		return null;
	}
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
	const tzDate = Date.UTC(
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
	const wallMs = candidateMs + offsetMsFromFormatter(formatter, candidateMs);
	if (!cronMatchesUTC(schedule, wallMs)) return false;
	// DST fall-back: an ambiguous local time repeats. Fire only the FIRST
	// instant, matching common cron implementations. The repeated span is not
	// always one hour (Australia/Lord_Howe falls back by 30 minutes), so derive
	// the actual offset delta and reject candidates whose wall-clock already
	// existed at candidate-delta.
	const candidateOffset = offsetMsFromFormatter(formatter, candidateMs);
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
	// Bail on a non-representable base: scanning forward from a timestamp at/over
	// the max Date value would build ~366 days of Invalid Dates before returning
	// null (a ~26s pathological scan).
	if (!Number.isFinite(fromMs) || fromMs >= MAX_REPRESENTABLE_MS) return null;

	const start = Math.floor(fromMs / CRON_MINUTE_MS) * CRON_MINUTE_MS;
	// Cap the window at the max representable Date so a base near the ceiling
	// scans only the representable remainder, not ~527k Invalid-Date candidates.
	const cutoff = Math.min(start + CRON_SCAN_WINDOW_MS, MAX_REPRESENTABLE_MS);
	// Hoist ONE formatter for the entire scan. Previously getTimezoneOffsetMs
	// allocated a fresh Intl.DateTimeFormat per candidate minute — up to ~527k
	// allocations across the 366-day window.
	const formatter =
		timezone && timezone !== "UTC" ? buildTzFormatter(timezone) : null;

	for (
		let candidate = start + CRON_MINUTE_MS;
		candidate <= cutoff;
		candidate += CRON_MINUTE_MS
	) {
		if (cronMatches(schedule, candidate, timezone, formatter)) {
			return candidate;
		}
	}

	return null;
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
