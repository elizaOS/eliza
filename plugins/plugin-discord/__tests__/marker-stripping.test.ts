/**
 * Tests for interaction marker stripping in Discord connector output.
 * Ensures markers (CHOICE/FOLLOWUPS/TASK/FORM) never leak to user-facing output.
 *
 * Issue #19472: Interaction marker residue leaks across connector and app surfaces
 */
import { describe, expect, it } from "vitest";
import { normalizeDiscordMessageText } from "./utils";

describe("Discord marker stripping (issue #19472)", () => {
	it("strips CHOICE markers from message text", () => {
		const text = `Here's your choice:
[CHOICE:approval id=c1]
yes=Yes
no=No
[/CHOICE]`;
		const result = normalizeDiscordMessageText(text);
		expect(result).not.toContain("[CHOICE");
		expect(result).not.toContain("[/CHOICE]");
		expect(result).toContain("Here's your choice:");
	});

	it("strips FOLLOWUPS markers from message text", () => {
		const text = `Let me know next steps:
[FOLLOWUPS id=f1]
continue=Continue
restart=Start over
[/FOLLOWUPS]`;
		const result = normalizeDiscordMessageText(text);
		expect(result).not.toContain("[FOLLOWUPS");
		expect(result).not.toContain("[/FOLLOWUPS]");
		expect(result).toContain("Let me know next steps:");
	});

	it("strips TASK markers from message text", () => {
		const text = `Here's what you need to do:
[TASK:550e8400-e29b-41d4-a716-446655440000]Important Task[/TASK]`;
		const result = normalizeDiscordMessageText(text);
		expect(result).not.toContain("[TASK:");
		expect(result).not.toContain("[/TASK]");
		expect(result).toContain("Here's what you need to do:");
	});

	it("strips FORM markers from message text", () => {
		const text = `Please fill out this form:
[FORM]
{"id":"form1","fields":[{"name":"email","type":"text"}]}
[/FORM]`;
		const result = normalizeDiscordMessageText(text);
		expect(result).not.toContain("[FORM]");
		expect(result).not.toContain("[/FORM]");
		expect(result).toContain("Please fill out this form:");
	});

	it("strips multiple marker types from one message", () => {
		const text = `Here are your options:
[CHOICE:approval id=c1]
yes=Yes
[/CHOICE]

Next steps:
[FOLLOWUPS id=f1]
continue=Continue
[/FOLLOWUPS]

Task:
[TASK:550e8400-e29b-41d4-a716-446655440000]Do this[/TASK]`;
		const result = normalizeDiscordMessageText(text);
		expect(result).not.toContain("[CHOICE");
		expect(result).not.toContain("[FOLLOWUPS");
		expect(result).not.toContain("[TASK:");
		expect(result).toContain("Here are your options:");
		expect(result).toContain("Next steps:");
		expect(result).toContain("Task:");
	});

	it("preserves prose text around markers", () => {
		const text = `The quick brown fox
[CHOICE:test]
a=Option A
[/CHOICE]
jumps over the lazy dog`;
		const result = normalizeDiscordMessageText(text);
		expect(result).toContain("The quick brown fox");
		expect(result).toContain("jumps over the lazy dog");
		expect(result).not.toContain("[CHOICE");
	});

	it("cleans up extra whitespace after marker removal", () => {
		const text = `Hello

[CHOICE:approval]
yes=Yes
[/CHOICE]

World`;
		const result = normalizeDiscordMessageText(text);
		expect(result).toContain("Hello");
		expect(result).toContain("World");
		// Should not have excessive blank lines
		expect(result).not.toMatch(/\n{3,}/);
	});

	it("handles empty marker blocks gracefully", () => {
		const text = `Text before
[CHOICE:test]

[/CHOICE]
Text after`;
		const result = normalizeDiscordMessageText(text);
		expect(result).not.toContain("[CHOICE");
		expect(result).toContain("Text before");
		expect(result).toContain("Text after");
	});

	it("does not strip unrelated bracket content", () => {
		const text = `User said [hello] and [goodbye]
[CHOICE:test]
yes=Yes
[/CHOICE]`;
		const result = normalizeDiscordMessageText(text);
		expect(result).toContain("[hello]");
		expect(result).toContain("[goodbye]");
		expect(result).not.toContain("[CHOICE");
	});

	it("handles marker-only messages (returns fallback text)", () => {
		const text = `[CHOICE:test]
yes=Yes
[/CHOICE]`;
		const result = normalizeDiscordMessageText(text);
		// Should not crash and should not contain markers
		expect(result).not.toContain("[CHOICE");
		expect(typeof result).toBe("string");
	});

	it("normalizes structured input with markers stripped", () => {
		const input = `Important info:
[FOLLOWUPS id=f1]
action1=Do Something
[/FOLLOWUPS]`;
		const result = normalizeDiscordMessageText(input);
		expect(result).toContain("Important info:");
		expect(result).not.toContain("[FOLLOWUPS");
		expect(result).not.toContain("action1=Do Something");
	});

	it("handles all marker types in compliance matrix", () => {
		const markers = [
			{
				name: "CHOICE",
				text: "[CHOICE:scope id=id]\nopt=Opt\n[/CHOICE]",
			},
			{ name: "FOLLOWUPS", text: "[FOLLOWUPS id=id]\nopt=Opt\n[/FOLLOWUPS]" },
			{
				name: "TASK",
				text: "[TASK:550e8400-e29b-41d4-a716-446655440000]Title[/TASK]",
			},
			{ name: "FORM", text: '[FORM]\n{"id":"id","fields":[]}\n[/FORM]' },
		];

		for (const marker of markers) {
			const text = `Before
${marker.text}
After`;
			const result = normalizeDiscordMessageText(text);
			expect(result).toContain("Before");
			expect(result).toContain("After");
			expect(result).not.toContain(`[${marker.name}`);
			expect(result).not.toContain(`[/${marker.name}`);
		}
	});
});
