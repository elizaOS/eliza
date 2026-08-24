/**
 * Coverage for task.
 */
import { describe, expect, it } from "vitest";
import { TaskStatus } from "./task.js";

describe("task", () => {
	it("exposes the canonical task status vocabulary", () => {
		expect(typeof TaskStatus).toBe("object");
		expect(Object.keys(TaskStatus)).toEqual([
			"UNSPECIFIED",
			"PENDING",
			"IN_PROGRESS",
			"COMPLETED",
			"FAILED",
			"CANCELLED",
		]);
	});

	it("persists each status under its own name", () => {
		for (const name of Object.keys(TaskStatus)) {
			expect(TaskStatus[name]).toBe(name);
		}
	});

	it("uses non-empty SCREAMING_SNAKE_CASE persisted tokens", () => {
		for (const token of Object.values(TaskStatus)) {
			expect(token).toMatch(/^[A-Z][A-Z0-9_]*$/);
		}
	});

	it("gives every status a distinct persisted token", () => {
		const tokens = Object.values(TaskStatus);
		expect(new Set(tokens).size).toBe(tokens.length);
	});
});
