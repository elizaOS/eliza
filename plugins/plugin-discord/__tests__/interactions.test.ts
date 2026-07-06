/**
 * Unit tests for `renderDiscordInteractions` — mapping neutral
 * `InteractionBlock` output to Discord action-row/button components.
 * Pure-function assertions.
 */
import type { Content } from "@elizaos/core";
import {
	buildInteractionUrlResolver,
	decodeCallback,
	FORM_FREE_TEXT_INVITE,
} from "@elizaos/core";
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

	it("uses Discord's 100-byte custom_id budget for longer callback values", () => {
		const value = "x".repeat(74);
		const content: Content = {
			text: `Approve?\n[CHOICE:approve id=c1]\n${value}=Long callback\n[/CHOICE]`,
		};

		const out = renderDiscordInteractions(content);
		expect(out.needsFreeTextReply).toBe(false);
		expect(out.components).toHaveLength(1);
		const button = out.components[0]?.components[0];
		expect(button?.label).toBe("Long callback");
		expect(button?.custom_id.length).toBe(78);
		expect(decodeCallback(button?.custom_id)).toEqual({
			kind: "reply",
			value,
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

	it("renders a navigate followup as a link button via resolveNavigateUrl (#8908)", () => {
		const out = renderDiscordInteractions(
			{
				text: "Done.\n[FOLLOWUPS id=f1]\nnavigate:/orchestrator=Open tasks\nreply:thanks=Thanks\n[/FOLLOWUPS]",
			} as Content,
			{ resolveNavigateUrl: (p) => `https://app.test${p}` },
		);
		const buttons = out.components.flatMap((row) => row.components);
		const nav = buttons.find((b) => b.label === "Open tasks");
		const reply = buttons.find((b) => b.label === "Thanks");
		expect(nav?.style).toBe(5); // Link
		expect(nav?.url).toBe("https://app.test/orchestrator");
		expect(reply?.url).toBeUndefined();
		expect(reply?.custom_id).toBeTruthy();
	});
	// #14321 — no hosted /forms/:id page exists; the canonical resolver must not
	// mint a dead link-out. The form renders as prose + a free-text invite.
	it("renders a form as prose + free-text fallback, never a dead link (#14321)", () => {
		const out = renderDiscordInteractions(
			{
				text: 'Happy to set that up.\n[FORM]\n{"id":"f1","title":"Set your reminder","fields":[{"name":"when","type":"text"}]}\n[/FORM]',
			} as Content,
			buildInteractionUrlResolver("https://app.test"),
		);
		expect(out.components).toHaveLength(0);
		expect(out.needsFreeTextReply).toBe(true);
		expect(out.text).toContain("Set your reminder");
		expect(out.text).toContain(FORM_FREE_TEXT_INVITE);
		expect(out.text).not.toContain("/forms/");
	});
});
