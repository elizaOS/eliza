import { describe, expect, it } from "vitest";
import { findOwnedActionCorrectionFromMetadata } from "../services/message.ts";

describe("findOwnedActionCorrectionFromMetadata", () => {
	it("returns null when planner already included an explicit-intent action (SPAWN_AGENT)", () => {
		// Regression: the metadata corrector scores actions by keyword overlap
		// against the user message. SPAWN_AGENT has no keywords to match, so for
		// any coding-delegation request the scorer would otherwise rank a cross-
		// channel send action higher and silently override the planner's
		// deliberate SPAWN_AGENT choice, breaking the delegation.
		const result = findOwnedActionCorrectionFromMetadata(
			{ actions: [] },
			{ content: { text: "send a small pr to elizaOS/eliza" } },
			{ actions: ["REPLY", "SPAWN_AGENT"] },
		);
		expect(result).toBeNull();
	});

	it("returns null when planner picked SPAWN_AGENT alone", () => {
		const result = findOwnedActionCorrectionFromMetadata(
			{ actions: [] },
			{ content: { text: "build me an app that tracks coffee" } },
			{ actions: ["SPAWN_AGENT"] },
		);
		expect(result).toBeNull();
	});

	it("returns null when response has no actions", () => {
		const result = findOwnedActionCorrectionFromMetadata(
			{ actions: [] },
			{ content: { text: "anything" } },
			{ actions: [] },
		);
		expect(result).toBeNull();
	});

	it("returns a suggestion when the planner chose a low-scoring owned action", () => {
		// Positive-path guard: a future refactor that always returned null from
		// the explicit-intent early-return would still pass the three cases
		// above. This keeps the corrector's real job under test — upgrading a
		// weak planner pick to a clearly better owned action by keyword overlap.
		const runtime = {
			actions: [
				{
					name: "OWNER_SEND_MESSAGE",
					description:
						"Send a discord message to a contact or channel when the user asks to send, text, ping, or dm someone. Use this for owner send workflows.",
					tags: ["workflow"],
					similes: ["send discord message"],
				},
				{
					name: "READ_CALENDAR",
					description: "Read the user's calendar.",
				},
			],
		};
		const result = findOwnedActionCorrectionFromMetadata(
			runtime,
			{ content: { text: "send a discord message to the team channel" } },
			{ actions: ["READ_CALENDAR"] },
		);
		expect(result).not.toBeNull();
		expect(result?.actionName).toBe("OWNER_SEND_MESSAGE");
	});
});
