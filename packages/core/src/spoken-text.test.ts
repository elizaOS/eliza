/**
 * Unit coverage for core's `sanitizeSpeechText` (`spoken-text.ts`), focused on
 * the TTS pronunciation pass. Core carries its own copy of this helper because
 * it cannot import `@elizaos/shared` (the dependency runs the other way), so
 * the contraction rules are asserted here independently of the shared suite —
 * a regression in one copy must not hide behind the other's coverage.
 *
 * Deterministic string transforms; no TTS engine or runtime is involved.
 */
import { describe, expect, it } from "vitest";

import { sanitizeSpeechText } from "./spoken-text";

describe("sanitizeSpeechText — I am contraction", () => {
	it("contracts when a predicate complement follows", () => {
		expect(sanitizeSpeechText("I am ready.")).toBe("I'm ready.");
		expect(sanitizeSpeechText("I am Eliza.")).toBe("I'm Eliza.");
		expect(sanitizeSpeechText("I am not sure.")).toBe("I'm not sure.");
		expect(sanitizeSpeechText("Yes, I am here.")).toBe("Yes, I'm here.");
	});

	it("leaves a stranded am expanded — English cannot contract it", () => {
		expect(sanitizeSpeechText("Yes, I am.")).toBe("Yes, I am.");
		expect(sanitizeSpeechText("Here I am!")).toBe("Here I am!");
		expect(sanitizeSpeechText("That is who I am.")).toBe("That is who I am.");
		expect(sanitizeSpeechText("Tell me who I am and I am done.")).toBe(
			"Tell me who I am and I'm done.",
		);
	});

	it("preserves casing instead of collapsing emphasis to I'm", () => {
		expect(sanitizeSpeechText("I AM READY")).toBe("I AM READY");
		expect(sanitizeSpeechText("yes i am ready")).toBe("yes i am ready");
	});

	it("does not contract across a following clause boundary", () => {
		expect(sanitizeSpeechText("I am, however, ready.")).toBe(
			"I am, however, ready.",
		);
	});

	it("does not match a word that merely starts with am", () => {
		expect(sanitizeSpeechText("I ambient noise")).toBe("I ambient noise");
	});
});
