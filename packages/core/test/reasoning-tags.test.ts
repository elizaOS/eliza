import { describe, expect, it } from "vitest";
import { stripUnclosedTagSuffix } from "../src/utils/reasoning-tags.ts";

describe("stripUnclosedTagSuffix", () => {
	it("keeps a closed reasoning block and the visible text after it", () => {
		expect(
			stripUnclosedTagSuffix("Hello <think>secret</think> visible", "think"),
		).toBe("Hello <think>secret</think> visible");
	});

	it("strips only from the unclosed open when a closed block precedes it", () => {
		expect(
			stripUnclosedTagSuffix(
				"Hello <think>secret</think> visible <think>draft",
				"think",
			),
		).toBe("Hello <think>secret</think> visible ");
	});

	it("strips a lone unclosed open tag and everything after it", () => {
		expect(stripUnclosedTagSuffix("Hello <think>secret", "think")).toBe(
			"Hello ",
		);
	});

	it("leaves text without an open tag unchanged", () => {
		expect(stripUnclosedTagSuffix("Hello </think> visible", "think")).toBe(
			"Hello </think> visible",
		);
		expect(stripUnclosedTagSuffix("plain text", "think")).toBe("plain text");
	});
});
