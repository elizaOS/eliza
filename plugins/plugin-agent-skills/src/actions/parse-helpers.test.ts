/**
 * Unit tests for shared skill-action parsing and complete normalized machine
 * references.
 */

import { describe, expect, it } from "vitest";
import {
	describeSkillReference,
	detectEnableIntent,
	extractSlugFromMessage,
	skillReferenceLogView,
} from "./parse-helpers";

describe("extractSlugFromMessage", () => {
	it("still extracts a simple quoted slug", () => {
		expect(extractSlugFromMessage('install the "weather" skill')).toBe(
			"weather",
		);
	});

	it("extracts unquoted slugs by stripping filler and action words", () => {
		expect(
			extractSlugFromMessage("please can you install the notion-helper skill for me"),
		).toBe("notion-helper");
		expect(extractSlugFromMessage("enable calendar-sync")).toBe("calendar-sync");
		expect(extractSlugFromMessage("turn off github-alerts")).toBe("github-alerts");
	});

	it("returns null for empty input or when only filler words remain", () => {
		expect(extractSlugFromMessage("")).toBeNull();
		expect(extractSlugFromMessage("   ")).toBeNull();
		expect(extractSlugFromMessage("please can you install the skill for me")).toBeNull();
	});

	it("rejects unquoted text of 100 characters or longer", () => {
		const longText = `install custom-${"a".repeat(100)}-skill`;
		expect(extractSlugFromMessage(longText)).toBeNull();
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

describe("detectEnableIntent", () => {
	it("detects enable verbs accurately", () => {
		expect(detectEnableIntent("please enable the weather skill")).toBe(true);
		expect(detectEnableIntent("turn on spotify")).toBe(true);
		expect(detectEnableIntent("activate notifications")).toBe(true);
		expect(detectEnableIntent("start the background worker")).toBe(true);
	});

	it("detects disable verbs accurately", () => {
		expect(detectEnableIntent("please disable the weather skill")).toBe(false);
		expect(detectEnableIntent("turn off spotify")).toBe(false);
		expect(detectEnableIntent("deactivate notifications")).toBe(false);
		expect(detectEnableIntent("stop the background worker")).toBe(false);
	});

	it("returns null when intent is ambiguous or unrecognized", () => {
		expect(detectEnableIntent("what does the weather skill do?")).toBeNull();
		expect(detectEnableIntent("status of spotify")).toBeNull();
		expect(detectEnableIntent("")).toBeNull();
	});
});

describe("skill reference rendering", () => {
	it("quotes name-shaped references and falls back on blobs", () => {
		expect(describeSkillReference("weather")).toBe('"weather"');
		expect(describeSkillReference("a".repeat(64))).toBe(`"${"a".repeat(64)}"`);
		expect(describeSkillReference("line one\nline two")).toBe("that skill");
		expect(describeSkillReference("line one\rline two")).toBe("that skill");
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

