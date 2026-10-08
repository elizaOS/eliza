import { describe, expect, it } from "vitest";
import { sanitizeSpeechText } from "../src/spoken-text.ts";

describe("sanitizeSpeechText reasoning tags", () => {
	it("does not speak thought or thinking blocks", () => {
		expect(sanitizeSpeechText("<thought>secret plan</thought> Hello")).toBe(
			"Hello",
		);
		expect(sanitizeSpeechText("<thinking>hidden</thinking> Hello")).toBe(
			"Hello",
		);
		expect(sanitizeSpeechText("<reflection>hidden</reflection> Hello")).toBe(
			"Hello",
		);
		expect(sanitizeSpeechText("<antthinking>hidden</antthinking> Hello")).toBe(
			"Hello",
		);
		expect(sanitizeSpeechText("<think>secret</think> Hello")).toBe("Hello");
	});
});
