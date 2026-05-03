import { describe, expect, it } from "vitest";
import {
	extractFirstSentence,
	hasFirstSentence,
} from "../utils/text-splitting";

describe("Text Splitting", () => {
	it("should split a simple sentence", () => {
		const text = "Hello world. How are you?";
		const { first, rest } = extractFirstSentence(text);
		expect(first).toBe("Hello world.");
		expect(rest).toBe("How are you?");
	});

	it("should handle exclamation marks", () => {
		const text = "Wow! That is cool.";
		const { first, rest } = extractFirstSentence(text);
		expect(first).toBe("Wow!");
		expect(rest).toBe("That is cool.");
	});

	it("should handle question marks", () => {
		const text = "Really? I did not know.";
		const { first, rest } = extractFirstSentence(text);
		expect(first).toBe("Really?");
		expect(rest).toBe("I did not know.");
	});

	it("should handle abbreviations correctly", () => {
		const text = "Dr. Smith is here. He is nice.";
		const { first, rest } = extractFirstSentence(text);
		expect(first).toBe("Dr. Smith is here.");
		expect(rest).toBe("He is nice.");
	});

	it("should not split on abbreviation", () => {
		const text = "Mr. Bond"; // Incomplete sentence context, acts as one block if no punctuation at end
		const { first, rest } = extractFirstSentence(text);
		expect(first).toBe("Mr. Bond");
		expect(rest).toBe("");
	});

	it("should return full text if no split found", () => {
		const text = "This is a single long sentence without end punctuation";
		const { first, rest } = extractFirstSentence(text);
		expect(first).toBe(
			"This is a single long sentence without end punctuation",
		);
		expect(rest).toBe("");
	});

	it("should detect partial sentence via hasFirstSentence", () => {
		expect(hasFirstSentence("Hello.")).toBe(false); // Wait, "Hello." -> first="Hello.", rest="" -> hasFirstSentence is checking if split happened?
		// Actually for streaming we want to know if we *can* split safely.
		// My implementation of hasFirstSentence checks if 'rest' > 0.
		// So "Hello." would return false because rest is empty.
		// "Hello. World" would return true.
		expect(hasFirstSentence("Hello. World")).toBe(true);
		expect(hasFirstSentence("Hello world")).toBe(false);
	});
});
