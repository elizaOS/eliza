/**
 * `sanitizeSpeechText` drops roleplay stage directions (`*sighs*`) but must
 * speak markdown emphasis. Model replies bold and italicize the words that
 * matter most, such as the setting to open or the option to pick.
 */

import { describe, expect, it } from "vitest";
import { sanitizeSpeechText } from "../src/spoken-text";

describe("sanitizeSpeechText star spans", () => {
	it("speaks bold and italic words", () => {
		expect(
			sanitizeSpeechText("Step 1: open **Settings**, then tap **Privacy**."),
		).toBe("Step 1: open Settings, then tap Privacy.");
		expect(sanitizeSpeechText("Your options are: **A** or **B**.")).toBe(
			"Your options are: A or B.",
		);
		expect(sanitizeSpeechText("I *love* it")).toBe("I love it");
	});

	it("still drops stage directions", () => {
		expect(sanitizeSpeechText("*sighs* Fine, I will do it.")).toBe(
			"Fine, I will do it.",
		);
		expect(sanitizeSpeechText("Hello *waves* friend")).toBe("Hello friend");
		expect(sanitizeSpeechText("**laughs** okay")).toBe("okay");
	});

	it("drops an unlisted action at the start of the reply or a sentence", () => {
		expect(
			sanitizeSpeechText("*adjusts glasses* Let me check that for you."),
		).toBe("Let me check that for you.");
		expect(sanitizeSpeechText("*takes a deep breath* Okay, here goes.")).toBe(
			"Okay, here goes.",
		);
		expect(sanitizeSpeechText("*rolls eyes* Fine.")).toBe("Fine.");
		expect(
			sanitizeSpeechText("Sure. *leans in closer* Can I tell you a secret?"),
		).toBe("Sure. Can I tell you a secret?");
	});

	it("speaks a lone italic word after a colon or opening a sentence", () => {
		expect(sanitizeSpeechText("Your choices: *yes* or *no*.")).toBe(
			"Your choices: yes or no.",
		);
		expect(sanitizeSpeechText("*Important:* call your doctor today.")).toBe(
			"Important: call your doctor today.",
		);
		expect(sanitizeSpeechText("Pick one. *Carefully* read the label.")).toBe(
			"Pick one. Carefully read the label.",
		);
	});

	it("speaks bold at the start of a sentence", () => {
		expect(sanitizeSpeechText("**Your flight** leaves at nine.")).toBe(
			"Your flight leaves at nine.",
		);
	});

	it("speaks a bold-italic phrase at the start of a sentence", () => {
		expect(sanitizeSpeechText("***Very important***: read this.")).toBe(
			"Very important: read this.",
		);
		expect(sanitizeSpeechText("***Do not share the code*** with anyone.")).toBe(
			"Do not share the code with anyone.",
		);
	});
});
