/**
 * `sanitizeSpeechText` must keep a currency sign before an amount. TTS reads
 * "€20" as "20 euros". Without the sign the user hears only "20".
 */

import { describe, expect, it } from "vitest";
import { sanitizeSpeechText } from "../src/spoken-text";

describe("sanitizeSpeechText currency signs", () => {
	it("keeps every currency sign, not only the dollar sign", () => {
		expect(sanitizeSpeechText("It costs €20 a month.")).toBe(
			"It costs €20 a month.",
		);
		expect(sanitizeSpeechText("That is £5 per ticket.")).toBe(
			"That is £5 per ticket.",
		);
		expect(sanitizeSpeechText("Your plan is ₹499 a month.")).toBe(
			"Your plan is ₹499 a month.",
		);
		expect(sanitizeSpeechText("The fare is ¥3,000.")).toBe(
			"The fare is ¥3,000.",
		);
		expect(sanitizeSpeechText("Pay $20 today.")).toBe("Pay $20 today.");
	});
});
