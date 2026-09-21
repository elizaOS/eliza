/**
 * Completed-effect claim detection for the calendar move verbs. A fabricated
 * "Moved it. … is now Friday at 4:00 PM." after a search-only turn shipped
 * live (2026-09-16, gate 181) because the verb lists knew "updated" but not
 * "moved" or "rescheduled". Deterministic; no runtime.
 */
import { describe, expect, it } from "vitest";
import { replyClaimsCompletedSideEffect } from "./side-effect-claims";

describe("replyClaimsCompletedSideEffect: move verbs", () => {
	it.each([
		"Moved it. Optometrist appointment is now Friday, September 18 at 4:00 PM.",
		"Rescheduled your dentist appointment to 5pm.",
		"I've moved the notary appointment to Friday at 4pm.",
		"I rescheduled the appointment for Thursday.",
		"Appointment moved: Friday 4pm.",
		"Postponed the standup task to 10am.",
	])("recognises a completed move claim: %s", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(true);
	});

	it.each([
		"Should I move it to 5pm?",
		"Want me to reschedule it for Thursday?",
		"The appointment you moved last week is still on Friday.",
		"I can move it once you confirm the time.",
	])("leaves offers, questions and descriptions alone: %s", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
	});
});
