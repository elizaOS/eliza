/**
 * Activity Pattern Service
 *
 * SIMPLIFIED: Hour-based rotation to spread actors across the day.
 * Each actor is assigned to a "shift" based on their ID hash.
 * Active for 10 hours, rotating through 24 hours.
 * This ensures all 140+ actors get fair coverage without timezone complexity.
 *
 * Game day is used for daily rotation - different actors are active on different
 * game days, keeping the narrative fresh while maintaining determinism within a day.
 */

/**
 * Minimal actor interface for activity patterns.
 * Compatible with both Actor and StaticActor types.
 */
export interface ActivityActor {
  id: string;
  domain?: string[];
  personality?: string;
}

/**
 * Activity pattern for an NPC (simplified)
 */
export interface ActivityPattern {
  /** IANA timezone string */
  timezone: string;
  /** Hours when most active (0-23) */
  peakHours: number[];
  /** Whether the NPC is active late night */
  nightOwl: boolean;
  /** Whether the NPC posts during typical work hours */
  workaholic: boolean;
  /** Whether the NPC is active on weekends */
  weekendActive: boolean;
}

/**
 * Hours each actor is active per day.
 * 10 hours = ~42% of actors active at any time = ~59 actors from 140.
 * Increased from 8 to provide more overlap between actor schedules,
 * enabling better coverage and more diverse feed content.
 * Exported for use in UI/metrics if needed.
 */
export const ACTIVE_HOURS_PER_DAY = 10;

/**
 * Simple hash function to get a number from actor ID.
 * Used to deterministically assign actors to time slots.
 */
function hashActorId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash | 0; // Force 32-bit signed truncation
  }
  return hash >>> 0; // Convert to unsigned 32-bit integer
}

/**
 * Validate that gameDay is a finite integer >= 1.
 * Throws TypeError for invalid values to prevent silent bugs from modulo on bad inputs.
 */
function validateGameDay(gameDay: number, functionName: string): void {
  if (!Number.isFinite(gameDay) || !Number.isInteger(gameDay) || gameDay < 1) {
    throw new TypeError(
      `${functionName}: gameDay must be a finite integer >= 1, got ${gameDay}`,
    );
  }
}

/**
 * Get the hours an actor is active based on their ID and game day.
 * Spreads actors evenly across the 24-hour day.
 *
 * @param actorId - The actor's unique identifier
 * @param gameDay - The current game day (1-indexed from games.currentDay). Defaults to 1.
 */
function getActorActiveHours(actorId: string, gameDay = 1): number[] {
  validateGameDay(gameDay, "getActorActiveHours");

  // Combine actor ID hash with game day for daily rotation
  // Different actors will be active on different game days
  const startHour = (hashActorId(actorId) + gameDay) % 24;

  // Generate 10 consecutive hours (wrapping around midnight)
  const hours: number[] = [];
  for (let i = 0; i < ACTIVE_HOURS_PER_DAY; i++) {
    hours.push((startHour + i) % 24);
  }
  return hours;
}

/**
 * Convert UTC hour to local hour for a timezone.
 *
 * **Note:** This is currently a no-op that returns utcHour unchanged.
 * The _timezone and _date parameters are intentionally unused and kept for API compatibility.
 * Real timezone conversion should be implemented here when timezone-aware activity patterns
 * are needed. For now, all activity patterns operate in UTC.
 *
 * @param utcHour - The hour in UTC (0-23)
 * @param _timezone - Unused timezone string (reserved for future use)
 * @param _date - Unused date parameter (reserved for future DST handling)
 * @returns The same utcHour value unchanged
 */
export function convertToLocalHour(
  utcHour: number,
  _timezone: string,
  _date: Date = new Date(),
): number {
  return utcHour;
}

/**
 * Derive activity pattern from actor data.
 * Uses actor ID to determine their active hours.
 *
 * **Note:** The returned {@link ActivityPattern} currently uses hardcoded boolean flags:
 * `nightOwl`, `workaholic`, and `weekendActive` are always `true` and do not vary
 * by actor or gameDay. This is intentional simplification for the current implementation.
 * These fields are reserved for future extension when actor-specific activity preferences
 * are added to the static actor data.
 *
 * @param actor - The actor to derive pattern for
 * @param gameDay - The current game day (1-indexed) for rotation. Defaults to 1.
 */
export function deriveActivityPattern(
  actor: ActivityActor,
  gameDay = 1,
): ActivityPattern {
  // Actor metadata can override these defaults when those fields are added.
  return {
    timezone: "UTC",
    peakHours: getActorActiveHours(actor.id, gameDay),
    nightOwl: true,
    workaholic: true,
    weekendActive: true,
  };
}

/**
 * Check if an NPC is in their active hours right now.
 * Based on simple hour rotation from actor ID hash combined with game day.
 *
 * @param actor - The actor to check
 * @param utcHour - Current UTC hour (0-23)
 * @param gameDay - The current game day (1-indexed) for rotation. Defaults to 1.
 */
export function isActiveHour(
  actor: ActivityActor,
  utcHour: number,
  gameDay = 1,
): boolean {
  const activeHours = getActorActiveHours(actor.id, gameDay);
  return activeHours.includes(utcHour);
}

/**
 * Check if the current day is a weekend.
 *
 * @param gameDay - Optional game day number. If provided, uses game-relative week (gameDay % 7).
 *                  If not provided, falls back to real-world calendar.
 * @param date - Fallback date for real-world weekend check (only used if gameDay not provided).
 */
export function isWeekend(gameDay?: number, date: Date = new Date()): boolean {
  if (gameDay !== undefined) {
    validateGameDay(gameDay, "isWeekend");

    // Game days are 1-indexed (Day 1 is first day)
    // Convert to 0-indexed for modulo: (gameDay - 1) % 7
    // Weekend: indices 5 and 6 of each 7-day cycle
    // Since gameDay >= 1, (gameDay - 1) is always >= 0, so single modulo suffices
    const dayOfWeek = (gameDay - 1) % 7;
    return dayOfWeek === 5 || dayOfWeek === 6;
  }
  // Fallback to real-world calendar
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Get activity multiplier for an NPC at current time.
 * Returns 1.0 if in active hours, 0.0 otherwise.
 *
 * @param actor - The actor to check
 * @param date - The date to check (for extracting UTC hour)
 * @param gameDay - The current game day for rotation (1-indexed). Defaults to 1.
 */
export function getActivityMultiplier(
  actor: ActivityActor,
  date: Date = new Date(),
  gameDay = 1,
): number {
  const utcHour = date.getUTCHours();
  // isActiveHour calls getActorActiveHours which already validates gameDay
  return isActiveHour(actor, utcHour, gameDay) ? 1.0 : 0.0;
}

/**
 * Activity Pattern Service class for dependency injection.
 */
export class ActivityPatternService {
  derivePattern(actor: ActivityActor, gameDay?: number): ActivityPattern {
    return deriveActivityPattern(actor, gameDay);
  }

  isActiveHour(
    actor: ActivityActor,
    utcHour: number,
    gameDay?: number,
  ): boolean {
    return isActiveHour(actor, utcHour, gameDay);
  }

  getMultiplier(actor: ActivityActor, date?: Date, gameDay?: number): number {
    return getActivityMultiplier(actor, date, gameDay);
  }
}

// Singleton instance
export const activityPatternService = new ActivityPatternService();
