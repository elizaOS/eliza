/**
 * A reply that names an ordinary tag must keep the rest of the sentence.
 * `<HTML>`, `<JSON>`, `<HTTP>`, and `<HEAD>` are prose. An underscore tool
 * tag, and a bare tag whose body is a JSON object, stay tool markup.
 */
import { expect, it } from "vitest";
import {
	containsToolCallShapedMarkup,
	stripJsonStructuralJunkReply,
} from "../src/runtime/json-output";

it("keeps a sentence that names an ordinary uppercase tag", () => {
	const samples = [
		"The <HTML> tag wraps the document. It contains head and body.",
		"Save it as <JSON> in the config file, then restart.",
		"See <HTTP> status 404 when the file is missing. Try again.",
		"The page starts with <HEAD> and then the body text continues here.",
		"Send a <REPLY> with the answer, then stop.",
		"Use <HTML> <HEAD> for the document structure.",
		"Use <AI> for the short form.",
	];
	for (const sample of samples) {
		expect(stripJsonStructuralJunkReply(sample)).toBe(sample);
		expect(containsToolCallShapedMarkup(sample)).toBe(false);
	}
});

it("still removes an underscore tool tag and a bare tag with a JSON body", () => {
	const note = 'Call <NOTES_CREATE>{"title":"Plan"}</NOTES_CREATE> now.';
	expect(stripJsonStructuralJunkReply(note)).toBe("Call  now.");
	expect(containsToolCallShapedMarkup(note)).toBe(true);

	const browse =
		"Open <BROWSE_PAGE><url>https://example.test</url></BROWSE_PAGE> next.";
	expect(stripJsonStructuralJunkReply(browse)).toBe("Open  next.");
	expect(containsToolCallShapedMarkup(browse)).toBe(true);

	const search = 'Look up <SEARCH>{"q":"weather"}</SEARCH> for me.';
	expect(stripJsonStructuralJunkReply(search)).toBe("Look up  for me.");
	expect(containsToolCallShapedMarkup(search)).toBe(true);

	const unclosed = 'Saving <NOTES_CREATE>{"title":"Plan"} and then more.';
	expect(stripJsonStructuralJunkReply(unclosed)).toBe("Saving");
	expect(containsToolCallShapedMarkup(unclosed)).toBe(true);
});
