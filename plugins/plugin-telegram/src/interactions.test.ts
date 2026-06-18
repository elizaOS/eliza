import type { Content } from "@elizaos/core";
import { decodeCallback } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { renderTelegramInteractions } from "./interactions";

describe("renderTelegramInteractions", () => {
	it("passes plain replies through with no keyboard", () => {
		const out = renderTelegramInteractions({ text: "just a normal reply" } as Content);
		expect(out.text).toBe("just a normal reply");
		expect(out.keyboardRows).toHaveLength(0);
		expect(out.needsFreeTextReply).toBe(false);
	});

	it("renders a choice block as callback buttons and strips the marker", () => {
		const content: Content = {
			text: "Approve the deploy?\n[CHOICE:approve id=c1]\nyes=Yes, ship it\nno=Cancel\n[/CHOICE]",
		};
		const out = renderTelegramInteractions(content);
		expect(out.text).toBe("Approve the deploy?");
		expect(out.keyboardRows).toHaveLength(1);
		const buttons = out.keyboardRows[0];
		expect(buttons).toHaveLength(2);
		// the button carries an interaction callback that decodes to the option value
		const first = buttons[0] as { text: string; callback_data: string };
		expect(first.text).toBe("Yes, ship it");
		expect(decodeCallback(first.callback_data)).toEqual({ kind: "reply", value: "yes" });
	});

	it("links a task card out when a url resolver is provided", () => {
		const id = "abc12345-def6-7890-abcd-ef1234567890";
		const content: Content = { text: `[TASK:${id}]Ship the thing[/TASK]` };
		const out = renderTelegramInteractions(content, {
			resolveUrl: (b) => (b.kind === "task" ? `https://app/tasks?taskId=${b.threadId}` : undefined),
		});
		const button = out.keyboardRows[0]?.[0] as { text: string; url: string };
		expect(button.text).toBe("Open task");
		expect(button.url).toContain(id);
	});

	it("keeps a task title as text when no url is available", () => {
		const id = "abc12345-def6-7890-abcd-ef1234567890";
		const out = renderTelegramInteractions({ text: `[TASK:${id}]Ship it[/TASK]` } as Content);
		expect(out.text).toContain("Ship it");
		expect(out.keyboardRows).toHaveLength(0);
	});
});
