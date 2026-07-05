/**
 * Unit tests for `renderDiscordInteractions` — mapping neutral
 * `InteractionBlock` output to Discord action-row/button components.
 * Pure-function assertions.
 */
import type { Content } from "@elizaos/core";
import { buildInteractionUrlResolver, decodeCallback } from "@elizaos/core";
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

	it("renders a [FORM] as free-text prose with NO dead /forms/ link button, using the real url resolver (#14321)", () => {
		// The exact wiring the connector uses in production (messages.ts:1006).
		const resolver = buildInteractionUrlResolver("https://app.test");
		const content: Content = {
			text: `Let's get your trip details.\n[FORM]\n${JSON.stringify({
				title: "Trip details",
				description: "Where and when?",
				fields: [
					{ name: "dest", type: "text", label: "Destination" },
					{ name: "when", type: "text", label: "When" },
				],
			})}\n[/FORM]`,
		};
		const out = renderDiscordInteractions(content, resolver);
		// No hosted /forms/:id page exists → the connector must render no button.
		expect(out.components).toHaveLength(0);
		expect(out.text).toContain("Let's get your trip details.");
		expect(out.text).toContain("Trip details");
		expect(out.needsFreeTextReply).toBe(true);
		// Adversarial: no button in any action row carries a /forms/ URL.
		const urls = out.components.flatMap((row) =>
			row.components.map((b) => (b as { url?: string }).url ?? ""),
		);
		expect(urls.some((u) => u.includes("/forms/"))).toBe(false);
		expect(out.text).not.toContain("/forms/");
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
});
