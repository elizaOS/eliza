/**
 * Deterministic regression coverage for complete model-facing action catalog
 * rendering; no model or runtime integration is used.
 */
import { describe, expect, it } from "vitest";
import { formatActions } from "./actions.ts";
import type { Action } from "./types/components.ts";

describe("complete action prompt rendering", () => {
	it("preserves full descriptions, whitespace, and every example", () => {
		const action: Action = {
			name: "EXACT_ACTION",
			description: "Complete action description with important constraints.",
			descriptionCompressed: "short hint",
			parameters: [],
			examples: [
				[
					{ name: "user", content: { text: "first  exact\nrequest" } },
					{ name: "assistant", content: { actions: ["EXACT_ACTION"] } },
				],
				[
					{ name: "user", content: { text: "second exact request" } },
					{ name: "assistant", content: { actions: ["EXACT_ACTION"] } },
				],
			],
			validate: async () => true,
			handler: async () => undefined,
		};

		const rendered = formatActions([action], "complete-action-test");

		expect(rendered).toContain(action.description);
		expect(rendered).not.toContain('"description": "short hint"');
		expect(rendered).toContain("first  exact\\nrequest");
		expect(rendered).toContain("second exact request");
	});
});
