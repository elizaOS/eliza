/**
 * @module ttl
 * @description Smart TTL (Time-To-Live) management for form sessions
 *
 * ## Design Philosophy
 *
 * Traditional form systems delete abandoned forms after a fixed time.
 * This fails users who invest significant effort:
 *
 * - User A: Opens form, immediately abandons → 24h retention is fine
 * - User B: Spends 2 hours filling complex form → 24h retention loses their work!
 *
 * ## Effort-Based TTL
 *
 * This module calculates TTL based on user effort:
 *
 * ```
 * TTL = clamp(minDays, effortDays, maxDays)
 *
 * where:
 *   effortDays = minutesSpent * effortMultiplier
 * ```
 *
 * Default values:
 * - minDays: 14 (two weeks minimum)
 * - maxDays: 90 (three months maximum)
 * - effortMultiplier: 0.5 (10 minutes = 5 extra days)
 *
 * ## Examples
 *
 * | Time Spent | Extra Days | Total TTL |
 * |------------|------------|-----------|
 * | 0 min      | 0          | 14 days   |
 * | 10 min     | 5          | 14 days   |
 * | 30 min     | 15         | 15 days   |
 * | 2 hours    | 60         | 60 days   |
 * | 4 hours    | 120        | 90 days   |
 *
 * ## Nudge System
 *
 * The nudge system sends reminders for stale forms:
 *
 * 1. After 48 hours of inactivity (configurable)
 * 2. Maximum 3 nudges (configurable)
 * 3. At least 24 hours between nudges
 *
 * ## Expiration Warnings
 *
 * Before a session expires, we warn the user:
 *
 * - 24 hours before expiration
 * - "Your form will expire in 1 day. Say 'resume' to keep working."
 *
 * This gives users a chance to save their work.
 */

import type { FormDefinition, FormSession } from "./types";
import { FORM_DEFINITION_DEFAULTS } from "./types";

/**
 * Calculate TTL based on user effort.
 *
 * The more time a user spends on a form, the longer we keep it.
 * This prevents losing significant work while still cleaning up abandoned forms.
 *
 * WHY effort-based:
 * - Respects user investment
 * - Automatic cleanup of abandoned forms
 * - No manual expiration management needed
 *
 * @param session - Current session with effort tracking
 * @param form - Form definition with TTL configuration
 * @returns Expiration timestamp (milliseconds since epoch)
 */
export function calculateTTL(
  session: FormSession,
  form?: FormDefinition,
): number {
  const config = form?.ttl || {};

  // Get configuration with defaults
  const minDays = config.minDays ?? FORM_DEFINITION_DEFAULTS.ttl.minDays;
  const maxDays = config.maxDays ?? FORM_DEFINITION_DEFAULTS.ttl.maxDays;
  const multiplier =
    config.effortMultiplier ?? FORM_DEFINITION_DEFAULTS.ttl.effortMultiplier;

  // Calculate effort in minutes
  const minutesSpent = session.effort.timeSpentMs / 60000;

  // Calculate TTL in days based on effort
  // WHY this formula: Simple linear scaling, easy to understand
  // Example: 10 min work with 0.5 multiplier = 5 extra days
  const effortDays = minutesSpent * multiplier;

  // Clamp to [minDays, maxDays]
  // WHY clamp: Prevents both too-short and too-long retention
  const ttlDays = Math.min(maxDays, Math.max(minDays, effortDays));

  // Return expiration timestamp
  // WHY from Date.now(): Session might be restored, recalculate from now
  return Date.now() + ttlDays * 24 * 60 * 60 * 1000;
}

/**
 * Check if session should be nudged.
 *
 * Nudges are gentle reminders for stashed or inactive forms.
 *
 * WHY nudge:
 * - Users forget about forms they started
 * - Gentle reminders increase completion
 * - But too many nudges are annoying
 *
 * @param session - Session to check
 * @param form - Form definition with nudge configuration
 * @returns true if a nudge should be sent
 */
export function shouldNudge(
  session: FormSession,
  form?: FormDefinition,
): boolean {
  const nudgeConfig = form?.nudge;

  // Nudging disabled
  if (nudgeConfig?.enabled === false) {
    return false;
  }

  // Already at max nudges
  // WHY limit: Don't annoy users with endless reminders
  const maxNudges =
    nudgeConfig?.maxNudges ?? FORM_DEFINITION_DEFAULTS.nudge.maxNudges;
  if ((session.nudgeCount || 0) >= maxNudges) {
    return false;
  }

  // Check if enough time has passed since last interaction
  // WHY time check: Don't nudge active users
  const afterInactiveHours =
    nudgeConfig?.afterInactiveHours ??
    FORM_DEFINITION_DEFAULTS.nudge.afterInactiveHours;
  const inactiveMs = afterInactiveHours * 60 * 60 * 1000;

  const timeSinceInteraction = Date.now() - session.effort.lastInteractionAt;
  if (timeSinceInteraction < inactiveMs) {
    return false;
  }

  // Check if we already nudged recently (at least 24h between nudges)
  // WHY 24h minimum: Prevents daily spam, gives user time to respond
  if (session.lastNudgeAt) {
    const timeSinceNudge = Date.now() - session.lastNudgeAt;
    if (timeSinceNudge < 24 * 60 * 60 * 1000) {
      return false;
    }
  }

  return true;
}

/**
 * Check if session is expiring soon.
 *
 * Used to send expiration warnings before session is deleted.
 *
 * @param session - Session to check
 * @param withinMs - Time window in milliseconds
 * @returns true if session expires within the window
 */
export function isExpiringSoon(
  session: FormSession,
  withinMs: number,
): boolean {
  return session.expiresAt - Date.now() < withinMs;
}

/**
 * Check if session has expired.
 *
 * @param session - Session to check
 * @returns true if session has passed its expiration time
 */
export function isExpired(session: FormSession): boolean {
  return session.expiresAt < Date.now();
}

/**
 * Check if we should confirm before canceling.
 *
 * High-effort sessions deserve a confirmation before abandonment.
 *
 * WHY confirm:
 * - Prevent accidental loss of significant work
 * - "Are you sure?" for forms user invested in
 *
 * @param session - Session to check
 * @returns true if cancel should require confirmation
 */
export function shouldConfirmCancel(session: FormSession): boolean {
  // 5 minutes is the threshold for "significant effort"
  // WHY 5 minutes: Enough time to have done real work
  const minEffortMs = 5 * 60 * 1000;
  return session.effort.timeSpentMs > minEffortMs;
}

/**
 * Format remaining time for user display.
 *
 * Produces human-readable strings like:
 * - "14 days"
 * - "3 hours"
 * - "45 minutes"
 * - "expired"
 *
 * @param session - Session to format
 * @returns Human-readable time remaining
 */
export function formatTimeRemaining(session: FormSession): string {
  const remaining = session.expiresAt - Date.now();

  if (remaining <= 0) {
    return "expired";
  }

  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);

  // Show days if more than 24 hours
  if (days > 0) {
    return `${days} day${days > 1 ? "s" : ""}`;
  }

  // Show hours if more than 1 hour
  if (hours > 0) {
    return `${hours} hour${hours > 1 ? "s" : ""}`;
  }

  // Show minutes for less than 1 hour
  const minutes = Math.floor(remaining / (60 * 1000));
  return `${minutes} minute${minutes > 1 ? "s" : ""}`;
}

/**
 * Format effort for user display.
 *
 * Produces human-readable strings like:
 * - "just started"
 * - "5 minutes"
 * - "2 hours"
 * - "1h 30m"
 *
 * @param session - Session to format
 * @returns Human-readable effort description
 */
export function formatEffort(session: FormSession): string {
  const minutes = Math.floor(session.effort.timeSpentMs / 60000);

  if (minutes < 1) {
    return "just started";
  }

  if (minutes < 60) {
    return `${minutes} minute${minutes > 1 ? "s" : ""}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours} hour${hours > 1 ? "s" : ""}`;
  }

  return `${hours}h ${remainingMinutes}m`;
}
