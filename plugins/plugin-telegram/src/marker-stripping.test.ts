/**
 * Tests for interaction marker stripping in Telegram connector output.
 * Ensures markers (CHOICE/FOLLOWUPS/TASK/FORM) never leak to user-facing output.
 *
 * Issue #19472: Interaction marker residue leaks across connector and app surfaces
 */
import { describe, expect, it } from "vitest";
import { renderTelegramInteractions } from "./interactions";

describe("Telegram marker stripping (issue #19472)", () => {
	it("strips CHOICE markers from message text", () => {
		const content = {
			text: `Here's your choice:
[CHOICE:approval id=c1]
yes=Yes
no=No
[/CHOICE]`,
		};
		const result = renderTelegramInteractions(content);
		expect(result.text).not.toContain("[CHOICE");
		expect(result.text).not.toContain("[/CHOICE]");
		expect(result.text).toContain("Here's your choice:");
	});

	it("strips FOLLOWUPS markers from message text", () => {
		const content = {
			text: `Let me know next steps:
[FOLLOWUPS id=f1]
continue=Continue
restart=Start over
[/FOLLOWUPS]`,
		};
		const result = renderTelegramInteractions(content);
		expect(result.text).not.toContain("[FOLLOWUPS");
		expect(result.text).not.toContain("[/FOLLOWUPS]");
		expect(result.text).toContain("Let me know next steps:");
	});

	it("strips TASK markers from message text", () => {
		const content = {
			text: `Here's what you need to do:
[TASK:550e8400-e29b-41d4-a716-446655440000]Important Task[/TASK]`,
		};
		const result = renderTelegramInteractions(content);
		expect(result.text).not.toContain("[TASK:");
		expect(result.text).not.toContain("[/TASK]");
		expect(result.text).toContain("Here's what you need to do:");
	});

	it("strips FORM markers from message text", () => {
		const content = {
			text: `Please fill out this form:
[FORM]
{"id":"form1","fields":[{"name":"email","type":"text"}]}
[/FORM]`,
		};
		const result = renderTelegramInteractions(content);
		expect(result.text).not.toContain("[FORM]");
		expect(result.text).not.toContain("[/FORM]");
		expect(result.text).toContain("Please fill out this form:");
	});

	it("strips multiple marker types from one message", () => {
		const content = {
			text: `Here are your options:
[CHOICE:approval id=c1]
yes=Yes
[/CHOICE]

Next steps:
[FOLLOWUPS id=f1]
continue=Continue
[/FOLLOWUPS]

Task:
[TASK:550e8400-e29b-41d4-a716-446655440000]Do this[/TASK]`,
		};
		const result = renderTelegramInteractions(content);
		expect(result.text).not.toContain("[CHOICE");
		expect(result.text).not.toContain("[FOLLOWUPS");
		expect(result.text).not.toContain("[TASK:");
		expect(result.text).toContain("Here are your options:");
		expect(result.text).toContain("Next steps:");
		expect(result.text).toContain("Task:");
	});

	it("preserves prose text around markers", () => {
		const content = {
			text: `The quick brown fox
[CHOICE:test]
a=Option A
[/CHOICE]
jumps over the lazy dog`,
		};
		const result = renderTelegramInteractions(content);
		expect(result.text).toContain("The quick brown fox");
		expect(result.text).toContain("jumps over the lazy dog");
		expect(result.text).not.toContain("[CHOICE");
	});

	it("cleans up extra whitespace after marker removal", () => {
		const content = {
			text: `Hello

[CHOICE:approval]
yes=Yes
[/CHOICE]

World`,
		};
		const result = renderTelegramInteractions(content);
		expect(result.text).toContain("Hello");
		expect(result.text).toContain("World");
		// Should not have excessive blank lines
		expect(result.text).not.toMatch(/\n{3,}/);
	});

	it("handles empty marker blocks gracefully", () => {
		const content = {
			text: `Text before
[CHOICE:test]
[/CHOICE]
Text after`,
		};
		const result = renderTelegramInteractions(content);
		expect(result.text).not.toContain("[CHOICE");
		expect(result.text).toContain("Text before");
		expect(result.text).toContain("Text after");
	});

	it("does not strip unrelated bracket content", () => {
		const content = {
			text: `User said [hello] and [goodbye]
[CHOICE:test]
yes=Yes
[/CHOICE]`,
		};
		const result = renderTelegramInteractions(content);
		expect(result.text).toContain("[hello]");
		expect(result.text).toContain("[goodbye]");
		expect(result.text).not.toContain("[CHOICE");
	});

	it("handles marker-only messages (returns stripped text)", () => {
		const content = {
			text: `[CHOICE:test]
yes=Yes
[/CHOICE]`,
		};
		const result = renderTelegramInteractions(content);
		// Should not crash and should not contain markers
		expect(result.text).not.toContain("[CHOICE");
		expect(typeof result.text).toBe("string");
	});

	it("renders keyboard for valid markers while stripping text", () => {
		const content = {
			text: `Choose an option:
[CHOICE:test id=c1]
yes=Yes
no=No
[/CHOICE]`,
		};
		const result = renderTelegramInteractions(content);
		// Text should be stripped
		expect(result.text).not.toContain("[CHOICE");
		// But keyboard should be rendered
		expect(result.keyboardRows.length).toBeGreaterThan(0);
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
			const content = { text: `Before ${marker.text} After` };
			const result = renderTelegramInteractions(content);
			expect(result.text).toContain("Before");
			expect(result.text).toContain("After");
			expect(result.text).not.toContain(`[${marker.name}`);
			expect(result.text).not.toContain(`[/${marker.name}`);
		}
	});

	it("returns empty text when content is empty", () => {
		const content = { text: "" };
		const result = renderTelegramInteractions(content);
		expect(result.text).toBe("");
		expect(result.keyboardRows).toEqual([]);
	});

	it("returns empty text when content is undefined", () => {
		const content = { text: undefined };
		const result = renderTelegramInteractions(content);
		expect(result.text).toBe("");
		expect(result.keyboardRows).toEqual([]);
	});
});
