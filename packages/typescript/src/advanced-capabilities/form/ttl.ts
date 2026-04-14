/**
 * @module ttl
 * @description Smart TTL (Time-To-Live) management for form sessions
 *
 * Effort-based TTL: the more time a user spends on a form, the longer we keep it.
 */

import type { FormDefinition, FormSession } from "./types.ts";
import { FORM_DEFINITION_DEFAULTS } from "./types.ts";

/**
 * Calculate TTL based on user effort.
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

	const minDays = config.minDays ?? FORM_DEFINITION_DEFAULTS.ttl.minDays;
	const maxDays = config.maxDays ?? FORM_DEFINITION_DEFAULTS.ttl.maxDays;
	const multiplier =
		config.effortMultiplier ?? FORM_DEFINITION_DEFAULTS.ttl.effortMultiplier;

	const minutesSpent = session.effort.timeSpentMs / 60000;
	const effortDays = minutesSpent * multiplier;
	const ttlDays = Math.min(maxDays, Math.max(minDays, effortDays));

	return Date.now() + ttlDays * 24 * 60 * 60 * 1000;
}

/**
 * Check if session should be nudged.
 */
export function shouldNudge(
	session: FormSession,
	form?: FormDefinition,
): boolean {
	const nudgeConfig = form?.nudge;

	if (nudgeConfig?.enabled === false) {
		return false;
	}

	const maxNudges =
		nudgeConfig?.maxNudges ?? FORM_DEFINITION_DEFAULTS.nudge.maxNudges;
	if ((session.nudgeCount || 0) >= maxNudges) {
		return false;
	}

	const afterInactiveHours =
		nudgeConfig?.afterInactiveHours ??
		FORM_DEFINITION_DEFAULTS.nudge.afterInactiveHours;
	const inactiveMs = afterInactiveHours * 60 * 60 * 1000;

	const timeSinceInteraction = Date.now() - session.effort.lastInteractionAt;
	if (timeSinceInteraction < inactiveMs) {
		return false;
	}

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
 */
export function isExpiringSoon(
	session: FormSession,
	withinMs: number,
): boolean {
	return session.expiresAt - Date.now() < withinMs;
}

/**
 * Check if session has expired.
 */
export function isExpired(session: FormSession): boolean {
	return session.expiresAt < Date.now();
}

/**
 * Check if we should confirm before canceling.
 */
export function shouldConfirmCancel(session: FormSession): boolean {
	const minEffortMs = 5 * 60 * 1000;
	return session.effort.timeSpentMs > minEffortMs;
}

/**
 * Format remaining time for user display.
 */
export function formatTimeRemaining(session: FormSession): string {
	const remaining = session.expiresAt - Date.now();

	if (remaining <= 0) {
		return "expired";
	}

	const hours = Math.floor(remaining / (60 * 60 * 1000));
	const days = Math.floor(hours / 24);

	if (days > 0) {
		return `${days} day${days > 1 ? "s" : ""}`;
	}

	if (hours > 0) {
		return `${hours} hour${hours > 1 ? "s" : ""}`;
	}

	const minutes = Math.floor(remaining / (60 * 1000));
	return `${minutes} minute${minutes > 1 ? "s" : ""}`;
}

/**
 * Format effort for user display.
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
