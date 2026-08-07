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

	// A stranded copula cannot contract. Each of these has a word after "am",
	// so a following-token test alone would wrongly accept them.
	it("leaves a copula stranded by wh-movement or fronting expanded", () => {
		expect(sanitizeSpeechText("Here I am at last.")).toBe("Here I am at last.");
		expect(sanitizeSpeechText("That is who I am today.")).toBe(
			"That is who I am today.",
		);
		expect(sanitizeSpeechText("I know who I am now.")).toBe(
			"I know who I am now.",
		);
		expect(sanitizeSpeechText("Wherever I am is home.")).toBe(
			"Wherever I am is home.",
		);
	});

	it("leaves a clause-final am expanded", () => {
		expect(sanitizeSpeechText("Yes, I am.")).toBe("Yes, I am.");
		expect(sanitizeSpeechText("Here I am!")).toBe("Here I am!");
		expect(sanitizeSpeechText("That is who I am.")).toBe("That is who I am.");
		expect(sanitizeSpeechText("Tell me who I am and I am done.")).toBe(
			"Tell me who I am and I'm done.",
		);
	});

	it("contracts every casing and preserves it", () => {
		expect(sanitizeSpeechText("I AM READY")).toBe("I'M READY");
		expect(sanitizeSpeechText("yes i am ready")).toBe("yes i'm ready");
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
