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
});
