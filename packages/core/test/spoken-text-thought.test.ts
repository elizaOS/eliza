/** Verifies speech excludes reasoning spans while preserving surrounding visible prose. */
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
	it("keeps visible prose around attributed and unfinished reasoning blocks", () => {
		expect(
			sanitizeSpeechText(
				'Hello <THINKING mode="private">hidden</THINKING> world',
			),
		).toBe("Hello world");
		expect(sanitizeSpeechText("Hello <thought>unfinished reasoning")).toBe(
			"Hello",
		);
		expect(sanitizeSpeechText("Hello <thought")).toBe("Hello");
		expect(sanitizeSpeechText("<thoughtful>Visible prose</thoughtful>")).toBe(
			"Visible prose",
		);
		expect(
			sanitizeSpeechText("Hello <tool_call>arguments</tool_call> world"),
		).toBe("Hello world");
	});
});
