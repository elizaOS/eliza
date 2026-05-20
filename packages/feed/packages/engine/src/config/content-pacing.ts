/**
 * Content Pacing Configuration
 *
 * Controls the rate and timing of content generation to ensure realistic
 * posting patterns that mimic real social media behavior.
 *
 * @module engine/config/content-pacing
 *
 * @description
 * **Problem Solved:**
 * Without pacing controls, all actors post at maximum rate every tick, creating
 * an unrealistic flood of content that makes feeds overwhelming.
 *
 * **Pacing Mechanisms:**
 * 1. **Time-of-Day Multiplier** - Off-peak hours (9pm-9am) have reduced activity
 * 2. **Per-Actor Daily Limits** - Each actor can only post N times per day
 * 3. **Minimum Post Interval** - Actors must wait between posts
 * 4. **Global Per-Tick Limits** - Cap total posts per tick
 *
 * **Configuration:**
 * All values are configurable via environment variables. See `npc-activity.ts`
 * for the centralized configuration with env var support.
 *
 * @example
 * ```typescript
 * import { CONTENT_PACING, getTimeOfDayMultiplier, shouldActorPost } from './config/content-pacing';
 *
 * // Check if actor should post based on pacing rules
 * if (!shouldActorPost(actorId, lastPostTime, dailyPostCount)) {
 *   return; // Skip this actor
 * }
 * ```
 */

import { NPC_CONTENT_PACING_CONFIG } from "./npc-activity";

/**
 * Content pacing configuration constants
 *
 * Values are sourced from the centralized NPC_CONTENT_PACING_CONFIG
 * which supports environment variable overrides.
 *
 * Rationale for default values (based on user testing feedback):
 * - Users reported feed felt "flooded" with too many AI posts
 * - Real influencers typically post 3-5 times per day max
 * - Twitter/X peak engagement is roughly 9am-9pm in most timezones
 * - 12 posts/hour ≈ 1 post every 5 minutes, feels active but not overwhelming
 */
export const CONTENT_PACING = {
  /**
   * Activity multiplier during peak hours (9am-9pm local time).
   * 1.0 = full activity
   * @env NPC_PEAK_HOURS_MULTIPLIER
   */
  peakHoursMultiplier: NPC_CONTENT_PACING_CONFIG.peakHoursMultiplier,

  /**
   * Activity multiplier during off-peak hours (9pm-9am local time).
   * 0.3 = 70% chance to skip generation during night hours.
   * Rationale: Real social media activity drops ~60-70% overnight.
   * @env NPC_OFF_PEAK_MULTIPLIER
   */
  offPeakMultiplier: NPC_CONTENT_PACING_CONFIG.offPeakMultiplier,

  /**
   * Maximum posts any single actor can make in a 24-hour period.
   * Rationale: Real influencers/thought leaders rarely exceed 5 posts/day.
   * More than this feels spammy and reduces perceived authenticity.
   * @env NPC_CONTENT_MAX_POSTS_PER_ACTOR_PER_DAY
   */
  maxPostsPerActorPerDay: NPC_CONTENT_PACING_CONFIG.maxPostsPerActorPerDay,

  /**
   * Minimum time in milliseconds between posts from the same actor.
   * 30 minutes = 1800000ms
   * Rationale: Prevents rapid-fire posting that looks automated.
   * @env NPC_MIN_MINUTES_BETWEEN_POSTS (in minutes, converted to ms)
   */
  minTimeBetweenPostsMs:
    NPC_CONTENT_PACING_CONFIG.minMinutesBetweenPosts * 60 * 1000,

  /**
   * Maximum posts to generate across all actors in a single tick.
   * Rationale: With ~50 active actors, 5 posts/tick over 12 ticks/hour
   * = 60 posts/hour max burst, but distributed randomly feels natural.
   * @env NPC_MAX_POSTS_PER_TICK
   */
  maxPostsPerTick: NPC_CONTENT_PACING_CONFIG.maxPostsPerTick,

  /**
   * Target number of posts per hour across all actors.
   * Rationale: 12 posts/hour = 1 every 5 minutes on average.
   * User testing showed this rate felt "active but not overwhelming".
   * @env NPC_TARGET_POSTS_PER_HOUR
   */
  targetPostsPerHour: NPC_CONTENT_PACING_CONFIG.targetPostsPerHour,

  /**
   * Hours that count as "peak" for activity multiplier.
   * Rationale: Matches typical US/EU waking hours overlap (9am-9pm UTC-5 to UTC+1).
   * @env NPC_PEAK_HOUR_START, NPC_PEAK_HOUR_END
   */
  peakHourStart: NPC_CONTENT_PACING_CONFIG.peakHourStart,
  peakHourEnd: NPC_CONTENT_PACING_CONFIG.peakHourEnd,
} as const;

/**
 * Get the activity multiplier based on current hour.
 *
 * @param hour - Hour in 24h format (0-23). Defaults to current hour.
 * @returns Multiplier value (0.0-1.0) for content generation probability
 */
export function getTimeOfDayMultiplier(hour?: number): number {
  const currentHour = hour ?? new Date().getHours();

  const isPeakHour =
    currentHour >= CONTENT_PACING.peakHourStart &&
    currentHour < CONTENT_PACING.peakHourEnd;

  return isPeakHour
    ? CONTENT_PACING.peakHoursMultiplier
    : CONTENT_PACING.offPeakMultiplier;
}

/**
 * Check if an actor should post based on pacing rules.
 *
 * Evaluates:
 * 1. Daily post limit not exceeded
 * 2. Minimum time since last post has passed
 * 3. Time-of-day probability check
 *
 * @param lastPostTime - When the actor last posted (or null if never)
 * @param dailyPostCount - How many posts the actor has made today
 * @param hour - Current hour (0-23), defaults to current time
 * @returns True if actor should be allowed to post
 */
export function shouldActorPost(
  lastPostTime: Date | null,
  dailyPostCount: number,
  hour?: number,
): boolean {
  // Check daily limit
  if (dailyPostCount >= CONTENT_PACING.maxPostsPerActorPerDay) {
    return false;
  }

  // Check minimum interval between posts
  if (lastPostTime) {
    const timeSinceLastPost = Date.now() - lastPostTime.getTime();
    if (timeSinceLastPost < CONTENT_PACING.minTimeBetweenPostsMs) {
      return false;
    }
  }

  // Time-of-day probability check
  const multiplier = getTimeOfDayMultiplier(hour);
  if (multiplier < 1.0 && Math.random() > multiplier) {
    return false;
  }

  return true;
}

/**
 * Calculate how many posts should be generated this tick based on pacing.
 *
 * Uses probabilistic selection to maintain target posts per hour
 * while respecting the per-tick maximum.
 *
 * @param eligibleActorCount - Number of actors that passed individual pacing checks
 * @param ticksPerHour - How many ticks occur per hour (default: 60 for 1-minute ticks)
 * @returns Number of posts to generate (0 to maxPostsPerTick)
 */
export function calculatePostsForTick(
  eligibleActorCount: number,
  ticksPerHour: number = 60,
): number {
  const targetPostsPerTick = CONTENT_PACING.targetPostsPerHour / ticksPerHour;

  // Use the minimum of eligible actors and calculated target
  const calculatedPosts = Math.min(
    eligibleActorCount,
    Math.ceil(targetPostsPerTick),
  );

  // Apply the per-tick maximum
  return Math.min(calculatedPosts, CONTENT_PACING.maxPostsPerTick);
}

/**
 * Check if the current date is a new day compared to a reference date.
 * Used for resetting daily post counts.
 *
 * @param referenceDate - The date to compare against
 * @param currentDate - Current date (defaults to now)
 * @returns True if currentDate is a different calendar day than referenceDate
 */
export function isNewDay(referenceDate: Date, currentDate?: Date): boolean {
  const now = currentDate ?? new Date();
  return (
    now.getFullYear() !== referenceDate.getFullYear() ||
    now.getMonth() !== referenceDate.getMonth() ||
    now.getDate() !== referenceDate.getDate()
  );
}
