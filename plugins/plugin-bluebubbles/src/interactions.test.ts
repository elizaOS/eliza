/**
 * Deterministic coverage for BlueBubbles' text-only interaction rendering.
 * These tests cover the pure transport projection without requiring a macOS
 * BlueBubbles server.
 */

import { describe, expect, it } from "vitest";
import { renderBlueBubblesInteractionText } from "./interactions";

describe("renderBlueBubblesInteractionText", () => {
	it("strips markers and appends plain choice options", () => {
		const rendered = renderBlueBubblesInteractionText({
			text: "Pick:\n[CHOICE:next id=c1]\na=Alpha\nb=Beta\n[/CHOICE]",
		});

		expect(rendered).toBe("Pick:\n\n1. Alpha\n2. Beta\nReply with a number.");
		expect(rendered).not.toContain("[CHOICE");
	});

	it("keeps form fallbacks as prose only", () => {
		const rendered = renderBlueBubblesInteractionText({
			text: `[FORM]\n${JSON.stringify({
				title: "Reminder details",
				description: "Send the schedule.",
				fields: [{ name: "when", type: "datetime" }],
			})}\n[/FORM]`,
		});

		expect(rendered).toBe(
			"Reminder details\n\nSend the schedule.\n\nReply with your answer.",
		);
		expect(rendered).not.toContain("[FORM]");
	});

	it("renders task deep links against the app base url", () => {
		const rendered = renderBlueBubblesInteractionText(
			{ text: "[TASK:def67890]Open task[/TASK]" },
			"https://app.test/",
		);

		expect(rendered).toBe(
			"Open task\nhttps://app.test/orchestrator?taskId=def67890",
		);
	});
});
