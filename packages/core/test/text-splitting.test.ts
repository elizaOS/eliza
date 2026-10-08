/** Checks time abbreviations and sentence boundaries for direct and streamed text. */
import { describe, expect, it } from "vitest";
import {
	createFirstSentenceScanner,
	createFirstSentenceStreamTracker,
	extractFirstSentence,
} from "../src/utils/text-splitting.ts";

describe("extractFirstSentence", () => {
	it("does not end a sentence at a.m. or p.m.", () => {
		expect(extractFirstSentence("Meet at 5 p.m. tomorrow")).toEqual({
			first: "Meet at 5 p.m. tomorrow",
			rest: "",
			complete: false,
		});
		expect(extractFirstSentence("Meet at 5 a.m. tomorrow")).toEqual({
			first: "Meet at 5 a.m. tomorrow",
			rest: "",
			complete: false,
		});
		expect(extractFirstSentence("Meet at 5 P.M. tomorrow")).toEqual({
			first: "Meet at 5 P.M. tomorrow",
			rest: "",
			complete: false,
		});
	});

	it("finishes spoken replies ending in a time across every stream split", () => {
		for (const time of ["a.m.", "p.m.", "P.M."]) {
			for (const suffix of ["", "   ", '")', '")  ']) {
				const text = `Your alarm is set for 7 ${time}${suffix}`;
				expect(extractFirstSentence(text)).toEqual({
					first: text.trim(),
					rest: "",
					complete: true,
				});
				for (let split = 0; split <= text.length; split++) {
					const tracker = createFirstSentenceStreamTracker();
					expect(
						tracker.push(text.slice(0, split), text.slice(0, split)),
					).toBeUndefined();
					expect(tracker.push(text.slice(split), text)).toBeUndefined();
					expect(tracker.finish()).toBe(text.trimEnd().length);
				}
				const tracker = createFirstSentenceStreamTracker();
				for (let end = 1; end <= text.length; end++) {
					expect(
						tracker.push(text[end - 1], text.slice(0, end)),
					).toBeUndefined();
				}
				expect(tracker.finish()).toBe(text.trimEnd().length);
			}
		}
	});
	it("still ends a real sentence and keeps Dr. inside one", () => {
		expect(extractFirstSentence("Ends here. Next sentence")).toEqual({
			first: "Ends here.",
			rest: "Next sentence",
			complete: true,
		});
		expect(extractFirstSentence("See Dr. Smith today").complete).toBe(false);
	});
	it("keeps the same real boundary across every stream split of a time abbreviation", () => {
		for (const time of ["a.m.", "p.m.", "P.M."]) {
			const first = `Meet at 5 ${time} tomorrow.`;
			const text = `${first} Bring notes.`;
			for (let split = 0; split <= text.length; split++) {
				const scanner = createFirstSentenceScanner();
				const early = scanner.push(text.slice(0, split));
				const boundary = early ?? scanner.push(text.slice(split), true);
				expect(boundary).toBe(first.length);
			}
		}
	});
});
