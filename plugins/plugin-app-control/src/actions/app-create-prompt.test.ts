import { describe, expect, it } from "vitest";
import {
	buildCreatePrompt,
	buildEditPrompt,
	shouldOpenAppWhenReady,
} from "./app-create.js";

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

	it("gives existing-app edits a single-pass discovery and validation workflow", () => {
		const prompt = buildEditPrompt(
			"Change the heading and button, then open it for me",
			{
				name: "nubs-garden",
				displayName: "Nubs Garden",
			} as Parameters<typeof buildEditPrompt>[1],
			"/tmp/nubs-garden",
			{
				implementation: ["src/index.tsx"],
				tests: ["tests/app.test.tsx"],
			},
		);

		expect(prompt).toContain("sourceDir is already the exact app root");
		expect(prompt).toContain(
			"read the relevant implementation and matching tests before editing",
		);
		expect(prompt).toContain(
			"batch related replacements into one FILE write/edit per changed file",
		);
		expect(prompt).toContain("knownImplementationPaths: src/index.tsx");
		expect(prompt).toContain("knownTestPaths: tests/app.test.tsx");
		expect(prompt).toContain(
			"do not list directories, inspect index.html, or rediscover files",
		);
		expect(prompt).toContain(
			"do not run `bun install` for an edit unless a validation command first fails specifically because dependencies are missing",
		);
		expect(prompt).toContain(
			"run the three verification commands in one shell call",
		);
		expect(prompt).not.toContain("setupCommand: run `bun install`");
	});

	it("only requests Browser handoff when the human explicitly asks to see it", () => {
		expect(
			shouldOpenAppWhenReady(
				"Update the heading and button, then open it for me.",
			),
		).toBe(true);
		expect(
			shouldOpenAppWhenReady("Preview the website when it is ready."),
		).toBe(true);
		expect(shouldOpenAppWhenReady("Update the heading and button.")).toBe(
			false,
		);
		expect(shouldOpenAppWhenReady("Use an open source color library.")).toBe(
			false,
		);
	});
});
