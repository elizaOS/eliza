import type { Content } from "@elizaos/core";
import { decodeCallback } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { renderDiscordInteractions } from "../interactions";

describe("renderDiscordInteractions", () => {
	it("passes plain replies through with no components", () => {
		const out = renderDiscordInteractions({
			text: "a normal reply",
		} as Content);
		expect(out.text).toBe("a normal reply");
		expect(out.components).toHaveLength(0);
	});

	it("renders a choice block as a button action row and strips the marker", () => {
		const content: Content = {
			text: "Approve?\n[CHOICE:approve id=c1]\nyes=Yes, ship it\nno=Cancel\n[/CHOICE]",
		};
		const out = renderDiscordInteractions(content);
		expect(out.text).toBe("Approve?");
		expect(out.components).toHaveLength(1);
		const row = out.components[0];
		expect(row.type).toBe(1);
		expect(row.components).toHaveLength(2);
		const first = row.components[0];
		expect(first.type).toBe(2);
		expect(first.label).toBe("Yes, ship it");
		expect(decodeCallback(first.custom_id)).toEqual({
			kind: "reply",
			value: "yes",
		});
	});

	it("renders a task card as a link button when a url resolver is provided", () => {
		const id = "abc12345-def6-7890-abcd-ef1234567890";
		const out = renderDiscordInteractions(
			{ text: `[TASK:${id}]Ship it[/TASK]` } as Content,
			{
				resolveUrl: (b) =>
					b.kind === "task"
						? `https://app/tasks?taskId=${b.threadId}`
						: undefined,
			},
		);
		const button = out.components[0]?.components[0];
		expect(button?.style).toBe(5); // Link
		expect(button?.url).toContain(id);
		expect(button?.custom_id).toBe("");
	});

	it("caps action rows at the Discord limit of 5", () => {
		const options = Array.from(
			{ length: 30 },
			(_, i) => `o${i}=Option ${i}`,
		).join("\n");
		const out = renderDiscordInteractions({
			text: `[CHOICE:s id=c]\n${options}\n[/CHOICE]`,
		} as Content);
		expect(out.components.length).toBeLessThanOrEqual(5);
	});
});
