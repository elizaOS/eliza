import { describe, expect, it } from "vitest";
import { buildCreatePrompt, buildEditPrompt } from "./app-create.js";

describe("app coding completion proof", () => {
	it("requires actual changed paths and exact test counts for a new app", () => {
		const prompt = buildCreatePrompt(
			"Make a garden",
			"nubs-garden",
			"Nubs Garden",
			"/tmp/nubs-garden",
			null,
		);
		expect(prompt).toContain('"files":["<changed-relative-path>"]');
		expect(prompt).toContain('"passed":<exact passed count>');
		expect(prompt).not.toContain("src/App.tsx");
	});

	it("does not guess a React component path for an existing app", () => {
		const prompt = buildEditPrompt(
			"Change the color",
			{
				name: "nubs-garden",
				displayName: "Nubs Garden",
			} as Parameters<typeof buildEditPrompt>[1],
			"/tmp/nubs-garden",
		);
		expect(prompt).toContain('"files":["<changed-relative-path>"]');
		expect(prompt).not.toContain("src/App.tsx");
	});
});
