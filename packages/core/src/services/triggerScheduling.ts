import { logger } from "../logger";
import type { TriggerConfig, TriggerType } from "../types/trigger";

export const MIN_TRIGGER_INTERVAL_MS = 60_000;
export const MAX_TRIGGER_INTERVAL_MS = 31 * 24 * 60 * 60 * 1000;
export const DISABLED_TRIGGER_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

const CRON_FIELDS = 5;
const CRON_SCAN_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const CRON_MINUTE_MS = 60_000;

interface CronRange {
	min: number;
	max: number;
}

interface CronSchedule {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
}

const CRON_RANGES: readonly CronRange[] = [
	{ min: 0, max: 59 },
	{ min: 0, max: 23 },
	{ min: 1, max: 31 },
	{ min: 1, max: 12 },
	{ min: 0, max: 6 },
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
			if (single < range.min || single > range.max) return null;
			// `N/step` (e.g. `5/15`) means "from N to the range max, stepping by
			// step" — standard cron. Without a step it is just the single value.
			const upper = stepParts.length === 2 ? range.max : single;
			for (let value = single; value <= upper; value += step) {
				output.add(value);
			}
			continue;
		}

		if (rangeParts.length !== 2) return null;
		const start = parseInteger(rangeParts[0].trim());
		const end = parseInteger(rangeParts[1].trim());
		if (start === null || end === null) return null;
		if (start > end) return null;
		if (start < range.min || end > range.max) return null;
		for (let value = start; value <= end; value += step) {
			output.add(value);
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
	};
}

function cronMatchesUTC(schedule: CronSchedule, candidateMs: number): boolean {
	const candidate = new Date(candidateMs);
	return (
		schedule.minute.has(candidate.getUTCMinutes()) &&
		schedule.hour.has(candidate.getUTCHours()) &&
		schedule.dayOfMonth.has(candidate.getUTCDate()) &&
		schedule.month.has(candidate.getUTCMonth() + 1) &&
		schedule.dayOfWeek.has(candidate.getUTCDay())
	);
}

/** Maximum |ms| a JS Date can represent (±100,000,000 days from epoch). */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Timezone validity cache: `Intl.DateTimeFormat` construction is the only
 * reliable IANA check, and cron scans call the offset helper once per
 * candidate minute — validate each zone string once, warn once on failure,
 * and fall back to UTC explicitly instead of swallowing the RangeError.
 */
const timezoneValidity = new Map<string, boolean>();

function isValidTimezone(timezone: string): boolean {
	const cached = timezoneValidity.get(timezone);
	if (cached !== undefined) return cached;
	let valid = true;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
	} catch {
		valid = false;
	}
	timezoneValidity.set(timezone, valid);
	if (!valid) {
		logger.warn(
			`[TriggerScheduling] Invalid timezone "${timezone}" — evaluating cron schedule in UTC. Sentinel zones (e.g. "owner_local") must be resolved to an IANA zone before scheduling.`,
		);
	}
	return valid;
}

function getTimezoneOffsetMs(
	timezone: string | undefined,
	atMs: number,
): number {
	if (!timezone || timezone === "UTC") return 0;
	if (!isValidTimezone(timezone)) return 0;
	// Invalid-Date instants cannot be formatted; mirror the UTC path (which
	// simply never matches an Invalid Date) by treating them as offset 0.
	if (!Number.isFinite(atMs) || Math.abs(atMs) > MAX_DATE_MS) return 0;
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
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
	timezone?: string,
): boolean {
	if (!timezone || timezone === "UTC") {
		return cronMatchesUTC(schedule, candidateMs);
	}
	const offsetMs = getTimezoneOffsetMs(timezone, candidateMs);
	return cronMatchesUTC(schedule, candidateMs + offsetMs);
}

export function computeNextCronRunAtMs(
	expression: string,
	fromMs: number,
	timezone?: string,
): number | null {
	const schedule = parseCronExpression(expression);
	if (!schedule) return null;

	const start = Math.floor(fromMs / CRON_MINUTE_MS) * CRON_MINUTE_MS;
	const cutoff = start + CRON_SCAN_WINDOW_MS;

	for (
		let candidate = start + CRON_MINUTE_MS;
		candidate <= cutoff;
		candidate += CRON_MINUTE_MS
	) {
		if (cronMatches(schedule, candidate, timezone)) {
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
