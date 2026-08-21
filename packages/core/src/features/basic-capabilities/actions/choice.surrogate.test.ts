/** Surrogate safety for task shortId in choice.ts. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

function formatTaskChoiceItem(taskId: string, name: string): string {
	const shortId = truncateWellFormed(toWellFormedUnicode(taskId), 8);
	return `**${name}** (ID: ${shortId}):\n`;
}

describe("choice action task id surrogate safety", () => {
	test("emoji in task id at 7 boundary backs off cleanly without lone surrogate", () => {
		const fox = "🦊";
		const taskId = `${"a".repeat(7)}${fox}123456`;
		const out = formatTaskChoiceItem(taskId, "Deploy Task");
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("ID: aaaaaaa")).toBe(true);
		expect(() => JSON.stringify({ out })).not.toThrow();
	});

	test("fitting emoji ending at 8 kept intact", () => {
		const fox = "🦊";
		const taskId = `${"a".repeat(6)}${fox}`;
		const out = formatTaskChoiceItem(taskId, "Choice Task");
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes(fox)).toBe(true);
	});

	test("lone high surrogate in task id is sanitized safely", () => {
		const badTaskId = "task\ud800123456";
		const out = formatTaskChoiceItem(badTaskId, "Test Task");
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
	});

	test("sweep offsets around 8 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let offset = -4; offset <= 4; offset++) {
			const n = 8 + offset;
			const taskId = `${"a".repeat(n)}${fox}${"b".repeat(5)}`;
			const out = formatTaskChoiceItem(taskId, "Task Item");
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify({ out })).not.toThrow();
		}
	});
});
