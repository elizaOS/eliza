import { describe, expect, it } from "vitest";
import {
	formatTaskCompletionStatus,
	getTaskCompletionCacheKey,
	type TaskCompletionAssessment,
} from "../task-completion.ts";

const assessment: TaskCompletionAssessment = {
	assessed: true,
	completed: true,
	reason: "goal reached",
	source: "reflection",
	evaluatedAt: 123,
	messageId: "m1",
};

describe("getTaskCompletionCacheKey", () => {
	it("builds the namespaced key", () => {
		expect(getTaskCompletionCacheKey("m1")).toBe(
			"reflection-task-completion:m1",
		);
	});
});

describe("formatTaskCompletionStatus", () => {
	it("formats an assessment", () => {
		const out = formatTaskCompletionStatus(assessment);
		expect(out).toContain("# Reflection Task Completion");
		expect(out).toContain("assessed: true");
		expect(out).toContain("task_completed: true");
		expect(out).toContain("task_completion_reason: goal reached");
	});

	it("handles nullish input", () => {
		expect(formatTaskCompletionStatus(null)).toContain(
			"No task completion reflection",
		);
		expect(formatTaskCompletionStatus(undefined)).toContain(
			"No task completion reflection",
		);
	});
});
