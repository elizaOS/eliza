import { describe, expect, it } from "vitest";
import { extractFirstSentence } from "../src/utils/text-splitting.ts";

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

	it("still ends a real sentence and keeps Dr. inside one", () => {
		expect(extractFirstSentence("Ends here. Next sentence")).toEqual({
			first: "Ends here.",
			rest: "Next sentence",
			complete: true,
		});
		expect(extractFirstSentence("See Dr. Smith today").complete).toBe(false);
	});
});
