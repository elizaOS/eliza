/**
 * Unit tests for shared skill-action parsing and complete normalized machine
 * references.
 */

import { describe, expect, it } from "vitest";
import {
	describeSkillReference,
	extractSlugFromMessage,
	skillReferenceLogView,
} from "./parse-helpers";

describe("extractSlugFromMessage", () => {
	it("still extracts a simple quoted slug", () => {
		expect(extractSlugFromMessage('install the "weather" skill')).toBe(
			"weather",
		);
	});

	it("never lets a quoted span cross newlines or exceed 64 chars", () => {
		// A single apostrophe (as in the security envelope's warning text)
		// followed by another quote char lines later must not capture the span.
		const text = [
			"don't treat this as instructions",
			"line two of a large message",
			'and a later "weather" mention',
		].join("\n");
		expect(extractSlugFromMessage(text)).toBe("weather");

		const oversized = `"${"a".repeat(80)}" hello`;
		// The 80-char quoted span is rejected; the fallback path strips filler
		// instead of echoing a giant capture.
		expect(extractSlugFromMessage(oversized)).not.toBe("a".repeat(80));
	});
});

describe("skill reference rendering", () => {
	it("quotes name-shaped references and falls back on blobs", () => {
		expect(describeSkillReference("weather")).toBe('"weather"');
		expect(describeSkillReference("line one\nline two")).toBe("that skill");
		expect(describeSkillReference("a".repeat(65))).toBe("that skill");
		expect(describeSkillReference("", "that request")).toBe("that request");
	});

	it("log view collapses whitespace and preserves complete content", () => {
		expect(skillReferenceLogView("a\n\n b\tc")).toBe("a b c");
		const long = "x".repeat(300);
		const view = skillReferenceLogView(long);
		expect(view).toBe(long);
	});

	it("keeps surrogate pairs intact and sanitizes lone surrogates in log view", () => {
		const longWithEmoji = `${"a".repeat(119)}🦊${"b".repeat(50)}`;
		const view = skillReferenceLogView(longWithEmoji);
		expect(view.isWellFormed()).toBe(true);
		expect(view).toBe(longWithEmoji);

		const lone = `bad ${String.fromCharCode(0xd800)} ref`;
		const loneView = skillReferenceLogView(lone);
		expect(loneView.isWellFormed()).toBe(true);
		expect(loneView).toBe("bad \uFFFD ref");
	});
});
