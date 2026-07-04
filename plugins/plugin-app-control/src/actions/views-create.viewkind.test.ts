/**
 * Prompt contract tests for assigning ViewKind on created plugin views.
 */

import { describe, expect, it } from "vitest";
import { buildCreatePrompt } from "./views-create";

describe("buildCreatePrompt viewKind contract (#8917)", () => {
	const prompt = buildCreatePrompt(
		"a dashboard for X",
		"@elizaos/plugin-x",
		"Plugin X",
		"/tmp/work",
	);

	it("tells the agent to set viewKind", () => {
		expect(prompt).toContain("viewKindRule:");
		expect(prompt.toLowerCase()).toContain("viewkind");
	});

	it("names release (default), preview, developer, and forbids system", () => {
		expect(prompt).toContain('"release"');
		expect(prompt).toContain('"preview"');
		expect(prompt).toContain('"developer"');
		expect(prompt).toContain('"system"');
		expect(prompt.toLowerCase()).toContain("default");
		expect(prompt.toLowerCase()).toContain("dev tooling");
		expect(prompt.toLowerCase()).toContain("reserved for built-ins");
	});

	it("still requires a Plugin.views entry", () => {
		expect(prompt).toContain("viewRequirement:");
	});
});
