/**
 * @module schedule-utils
 * @description Utility functions for computing next run times and validating schedules
 *
 * Uses the 'croner' library for cron expression parsing which supports:
 * - Standard 5-field cron expressions (minute hour day month weekday)
 * - Extended 6-field expressions with seconds
 * - Timezone support via IANA timezone names
 */

import { Cron } from 'croner';
import type { CronSchedule, CronServiceConfig } from '../types.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';

/**
 * Parses an ISO 8601 timestamp string to milliseconds since epoch
 * @param timestamp ISO 8601 timestamp string
 * @returns Milliseconds since epoch, or null if invalid
 */
export function parseTimestamp(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * Validates an 'at' schedule
 * @param at ISO 8601 timestamp string
 * @returns Error message if invalid, null if valid
 */
export function validateAtSchedule(at: string): string | null {
  const ms = parseTimestamp(at);
  if (ms === null) {
    return `Invalid timestamp: "${at}". Expected ISO 8601 format (e.g., "2024-12-31T23:59:59Z")`;
  }
  return null;
}

/**
 * Validates an 'every' schedule
 * @param everyMs Interval in milliseconds
 * @param config Service configuration with minimum interval
 * @returns Error message if invalid, null if valid
 */
export function validateEverySchedule(
  everyMs: number,
  config: CronServiceConfig
): string | null {
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    return `Invalid interval: ${everyMs}. Must be a positive number`;
  }

  const minInterval = config.minIntervalMs ?? DEFAULT_CRON_CONFIG.minIntervalMs;
  if (everyMs < minInterval) {
    return `Interval too short: ${everyMs}ms. Minimum allowed is ${minInterval}ms`;
  }

  return null;
}

/**
 * Validates a cron expression
 * @param expr Cron expression string
 * @param tz Optional IANA timezone
 * @returns Error message if invalid, null if valid
 */
export function validateCronExpression(expr: string, tz?: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) {
    return 'Cron expression cannot be empty';
  }

  const trimmedTz = tz?.trim() || undefined;

  // Validate timezone if provided
  if (trimmedTz) {
    try {
      Intl.DateTimeFormat('en-US', { timeZone: trimmedTz });
    } catch {
      return `Invalid timezone: "${trimmedTz}"`;
    }
  }

  // Validate the cron expression by creating a Cron instance
  let cron: Cron;
  try {
    cron = new Cron(trimmed, { timezone: trimmedTz, catch: false });
  } catch (err) {
    return `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
  }

  const next = cron.nextRun();
  cron.stop();

  if (!next) {
    return `Cron expression "${trimmed}" will never run`;
  }

  return null;
}

/**
 * Validates a complete schedule
 * @param schedule The schedule to validate
 * @param config Service configuration
 * @returns Error message if invalid, null if valid
 */
export function validateSchedule(
  schedule: CronSchedule,
  config: CronServiceConfig
): string | null {
  switch (schedule.kind) {
    case 'at':
      return validateAtSchedule(schedule.at);

    case 'every':
      return validateEverySchedule(schedule.everyMs, config);

    case 'cron':
      return validateCronExpression(schedule.expr, schedule.tz);

    default: {
      // Exhaustive check - this should never happen with proper typing
      const _exhaustive: never = schedule;
      return `Unknown schedule kind: ${(_exhaustive as CronSchedule).kind}`;
    }
  }
}

/**
 * Computes the next run time for a schedule
 * @param schedule The schedule configuration
 * @param nowMs Current time in milliseconds since epoch
 * @returns Next run time in ms, or undefined if the schedule has no more runs
 */
export function computeNextRunAtMs(
  schedule: CronSchedule,
  nowMs: number
): number | undefined {
  switch (schedule.kind) {
    case 'at': {
      const atMs = parseTimestamp(schedule.at);
      if (atMs === null) {
        return undefined;
      }
      // Only return if the timestamp is in the future
      return atMs > nowMs ? atMs : undefined;
    }

    case 'every': {
      const everyMs = Math.max(1, Math.floor(schedule.everyMs));
      const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));

      // If we haven't reached the anchor yet, the anchor is the first run
      if (nowMs < anchor) {
        return anchor;
      }

      // Calculate how many intervals have elapsed since the anchor
      const elapsed = nowMs - anchor;
      const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));

      // Return the next interval boundary
      return anchor + steps * everyMs;
    }

    case 'cron': {
      const expr = schedule.expr.trim();
      if (!expr) {
        return undefined;
      }

      const cron = new Cron(expr, {
        timezone: schedule.tz?.trim() || undefined,
        catch: false,
      });

      const next = cron.nextRun(new Date(nowMs));
      cron.stop();

      return next ? next.getTime() : undefined;
    }

    default: {
      const _exhaustive: never = schedule;
      return undefined;
    }
  }
}

/**
 * Determines if a job is due for execution
 * @param nextRunAtMs The scheduled next run time
 * @param nowMs Current time
 * @param toleranceMs Tolerance window for considering a job "due" (default: 1000ms)
 * @returns true if the job should run now
 */
export function isJobDue(
  nextRunAtMs: number | undefined,
  nowMs: number,
  toleranceMs: number = 1000
): boolean {
  if (nextRunAtMs === undefined) {
    return false;
  }
  // A job is due if we're at or past its scheduled time
  // We add a small tolerance to handle timer drift
  return nowMs >= nextRunAtMs - toleranceMs;
}

/**
 * Formats a schedule for human-readable display
 * @param schedule The schedule to format
 * @returns Human-readable description
 */
export function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at': {
      const date = new Date(schedule.at);
      return `once at ${date.toLocaleString()}`;
    }

    case 'every': {
      const ms = schedule.everyMs;
      if (ms >= 86400000) {
        const days = Math.round(ms / 86400000);
        return `every ${days} day${days === 1 ? '' : 's'}`;
      }
      if (ms >= 3600000) {
        const hours = Math.round(ms / 3600000);
        return `every ${hours} hour${hours === 1 ? '' : 's'}`;
      }
      if (ms >= 60000) {
        const minutes = Math.round(ms / 60000);
        return `every ${minutes} minute${minutes === 1 ? '' : 's'}`;
      }
      const seconds = Math.round(ms / 1000);
      return `every ${seconds} second${seconds === 1 ? '' : 's'}`;
    }

    case 'cron': {
      const tz = schedule.tz ? ` (${schedule.tz})` : '';
      return `cron: ${schedule.expr}${tz}`;
    }

    default: {
      const _exhaustive: never = schedule;
      return 'unknown schedule';
    }
  }
}

/**
 * Parses a human-readable duration string to milliseconds
 * Supports formats like "5m", "2h", "1d", "30s"
 * @param duration Duration string
 * @returns Milliseconds (always > 0), or null if invalid or zero
 */
export function parseDuration(duration: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i.exec(
    duration.trim()
  );

  if (!match) {
    return null;
  }

  const value = parseFloat(match[1]);

  // Reject zero or negative values - they don't make sense for durations
  // and would cause issues with scheduling (infinite loops, immediate re-runs)
  if (value <= 0 || !Number.isFinite(value)) {
    return null;
  }

  const unit = match[2].toLowerCase();
  let ms: number;

  if (unit.startsWith('s')) {
    ms = Math.round(value * 1000);
  } else if (unit.startsWith('m')) {
    ms = Math.round(value * 60000);
  } else if (unit.startsWith('h')) {
    ms = Math.round(value * 3600000);
  } else if (unit.startsWith('d')) {
    ms = Math.round(value * 86400000);
  } else {
    return null;
  }

  // Final check: result must be at least 1ms
  return ms > 0 ? ms : null;
}

/**
 * Creates a schedule from a human-readable description
 * Supports:
 * - "in 5 minutes" / "in 2 hours" -> 'at' schedule
 * - "every 5 minutes" / "every hour" -> 'every' schedule
 * - "at 9am" / "at 2024-12-31" -> 'at' schedule
 * - Cron expressions (detected by field count)
 *
 * @param description Human-readable schedule description
 * @param nowMs Current time for relative calculations
 * @returns CronSchedule or undefined if parsing failed
 */
export function parseScheduleDescription(
  description: string,
  nowMs: number = Date.now()
): CronSchedule | undefined {
  const normalized = description.trim().toLowerCase();

  // Check for "in X duration" pattern (relative one-time)
  const inMatch = /^in\s+(.+)$/i.exec(normalized);
  if (inMatch) {
    const durationMs = parseDuration(inMatch[1]);
    if (durationMs !== null) {
      return {
        kind: 'at',
        at: new Date(nowMs + durationMs).toISOString(),
      };
    }
  }

  // Check for "every X duration" pattern (interval)
  const everyMatch = /^every\s+(.+)$/i.exec(normalized);
  if (everyMatch) {
    const durationMs = parseDuration(everyMatch[1]);
    if (durationMs !== null) {
      return {
        kind: 'every',
        everyMs: durationMs,
        anchorMs: nowMs,
      };
    }
  }

  // Check if it looks like a cron expression (has multiple space-separated fields)
  const fields = normalized.split(/\s+/);
  if (fields.length >= 5 && fields.length <= 6) {
    // Likely a cron expression
    const validation = validateCronExpression(normalized);
    if (validation === null) {
      return {
        kind: 'cron',
        expr: normalized,
      };
    }
  }

  // Try to parse as ISO timestamp
  const timestamp = parseTimestamp(description);
  if (timestamp !== null) {
    return {
      kind: 'at',
      at: description,
    };
  }

  return undefined;
}
