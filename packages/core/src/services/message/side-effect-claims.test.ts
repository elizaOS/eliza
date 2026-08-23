/**
 * Unit tests for ungrounded side-effect assertion detection and empty tracked work state claims.
 */

import { describe, expect, it } from "vitest";
import {
	replyClaimsCompletedSideEffect,
	replyClaimsEmptyTrackedWorkState,
} from "./side-effect-claims.js";

describe("side-effect-claims", () => {
	describe("replyClaimsCompletedSideEffect", () => {
		it("detects English first-person completed side effect claims", () => {
			expect(
				replyClaimsCompletedSideEffect("I've set a reminder for your meeting."),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect("I scheduled the appointment for 3pm."),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect("Done — your reminders are set."),
			).toBe(true);
			expect(replyClaimsCompletedSideEffect("Added todo: buy groceries.")).toBe(
				true,
			);
		});

		it("ignores consent-seeking offers and questions", () => {
			expect(
				replyClaimsCompletedSideEffect("Should I set a reminder for 9am?"),
			).toBe(false);
			expect(
				replyClaimsCompletedSideEffect("Would you like me to schedule a task?"),
			).toBe(false);
			expect(
				replyClaimsCompletedSideEffect(
					"When I set a reminder, I'll let you know.",
				),
			).toBe(false);
		});

		it("detects multilingual side effect assertions (Spanish, Portuguese, Chinese, Korean)", () => {
			expect(
				replyClaimsCompletedSideEffect(
					"He guardado el recordatorio para mañana.",
				),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect("Já salvei a sua tarefa no calendário."),
			).toBe(true);
			expect(replyClaimsCompletedSideEffect("我已经帮你把提醒设置好了。")).toBe(
				true,
			);
			expect(replyClaimsCompletedSideEffect("알림을 설정했어요.")).toBe(true);
		});

		it("returns false on empty or whitespace strings", () => {
			expect(replyClaimsCompletedSideEffect("")).toBe(false);
			expect(replyClaimsCompletedSideEffect("   ")).toBe(false);
		});
	});

	describe("replyClaimsEmptyTrackedWorkState", () => {
		it("detects claims asserting empty or absent tracked work state", () => {
			expect(replyClaimsEmptyTrackedWorkState("Your task list is empty.")).toBe(
				true,
			);
			expect(replyClaimsEmptyTrackedWorkState("No tasks logged today.")).toBe(
				true,
			);
			expect(
				replyClaimsEmptyTrackedWorkState(
					"I don't have today's log in front of me.",
				),
			).toBe(true);
			expect(
				replyClaimsEmptyTrackedWorkState(
					"Nothing is on your schedule for tomorrow.",
				),
			).toBe(true);
		});

		it("ignores conditional or question assertions about empty state", () => {
			expect(
				replyClaimsEmptyTrackedWorkState(
					"If your task list is empty, we can create one.",
				),
			).toBe(false);
			expect(
				replyClaimsEmptyTrackedWorkState(
					"Is your schedule clear for this afternoon?",
				),
			).toBe(false);
		});

		it("returns false on empty string", () => {
			expect(replyClaimsEmptyTrackedWorkState("")).toBe(false);
		});
	});
});
