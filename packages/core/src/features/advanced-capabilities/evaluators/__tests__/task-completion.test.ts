/**
 * Task-completion contract tests import the production evaluator helpers and
 * verify cache namespacing plus provider-facing assessment formatting.
 */
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

	it("keeps distinct message ids in distinct cache slots", () => {
		expect(getTaskCompletionCacheKey("m1")).not.toBe(
			getTaskCompletionCacheKey("m2"),
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

	it("renders the false arm of assessed and completed independently", () => {
		const notAssessed = formatTaskCompletionStatus({
			assessed: false,
			completed: true,
			reason: "still running",
			source: "reflection",
			evaluatedAt: 124,
		});
		expect(notAssessed).toContain("assessed: false");
		expect(notAssessed).toContain("task_completed: true");

		const notCompleted = formatTaskCompletionStatus({
			assessed: true,
			completed: false,
			reason: "subtask pending",
			source: "reflection",
			evaluatedAt: 125,
		});
		expect(notCompleted).toContain("assessed: true");
		expect(notCompleted).toContain("task_completed: false");
	});

	it("renders an unfinished assessment as the exact provider-facing document", () => {
		expect(
			formatTaskCompletionStatus({
				assessed: false,
				completed: false,
				reason: "waiting on user input",
				source: "reflection",
				evaluatedAt: 126,
			}),
		).toBe(
			[
				"# Reflection Task Completion",
				"assessed: false",
				"task_completed: false",
				"task_completion_reason: waiting on user input",
			].join("\n"),
		);
	});

	it("renders the complete document without leaking message ids", () => {
		const out = formatTaskCompletionStatus(assessment);
		expect(out).toBe(
			"# Reflection Task Completion\nassessed: true\ntask_completed: true\ntask_completion_reason: goal reached",
		);
		expect(out).not.toContain("m1");
	});
});
