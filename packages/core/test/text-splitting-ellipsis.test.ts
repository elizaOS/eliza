import { describe, expect, it } from "vitest";
import { extractFirstSentence } from "../src/utils/text-splitting.ts";

describe("extractFirstSentence", () => {
	it("does not end a sentence at an ellipsis", () => {
		expect(extractFirstSentence("Wait... then go.")).toEqual({
			first: "Wait... then go.",
			rest: "",
			complete: true,
		});
		expect(extractFirstSentence("Wait... then go. Next")).toEqual({
			first: "Wait... then go.",
			rest: "Next",
			complete: true,
		});
	});

	it("still ends a real sentence", () => {
		expect(extractFirstSentence("Ends here. Next sentence")).toEqual({
			first: "Ends here.",
			rest: "Next sentence",
			complete: true,
		});
	});
});
