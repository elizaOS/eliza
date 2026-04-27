/**
 * Contract test for the APP-action scenarios under test/scenarios/.
 *
 * Loads each scenario file and validates the shape — does NOT execute the
 * live scenario runner (which needs an LLM key + a real AgentRuntime).
 * The point is to keep the scenario fixtures from silently rotting:
 *
 *   - file is parseable by `import()` (TS resolves, no syntax errors)
 *   - default export looks like a scenario (id, title, turns, finalChecks)
 *   - referenced action / mode keywords appear somewhere in the scenario
 *     so a typo doesn't silently swap "APP" for "APPS" without a test
 *     catching it
 *   - finalChecks reference action names we actually ship (APP, etc.)
 *
 * Behavioral coverage of the scenarios — i.e. that they actually pass when
 * executed — lives in CI under `bun run test:scenarios`, which runs
 * `milady-scenarios run plugins/plugin-app-control/typescript/test/scenarios`
 * with a live LLM. This contract test guards the file shape so a scenario
 * that compiles but has nothing useful in it doesn't sneak through.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock(
	"@elizaos/scenario-schema",
	() => ({
		scenario: <T>(value: T) => value,
	}),
	{ virtual: true },
);

type FinalCheck = {
	type?: string;
	actionName?: string;
	[key: string]: unknown;
};

type Turn = {
	kind?: string;
	text?: string;
	[key: string]: unknown;
};

type LoadedScenario = {
	id?: string;
	title?: string;
	domain?: string;
	turns?: Turn[];
	finalChecks?: FinalCheck[];
	requires?: { plugins?: string[] };
	[key: string]: unknown;
};

const SCENARIOS_DIR = path.resolve(
	import.meta.dirname,
	"..",
	"..",
	"test",
	"scenarios",
);

const EXPECTED = [
	{
		file: "app-launch-basic.scenario.ts",
		id: "app-launch-basic",
		expectAction: "APP",
		expectKeywords: ["launch"],
	},
	{
		file: "app-list.scenario.ts",
		id: "app-list",
		expectAction: "APP",
		expectKeywords: ["list", "show", "running"],
	},
	{
		file: "app-relaunch.scenario.ts",
		id: "app-relaunch",
		expectAction: "APP",
		expectKeywords: ["relaunch", "restart"],
	},
	{
		file: "app-load-from-directory.scenario.ts",
		id: "app-load-from-directory",
		expectAction: "APP",
		expectKeywords: ["load", "directory", "register"],
	},
	{
		file: "app-create-no-existing.scenario.ts",
		id: "app-create-no-existing",
		expectAction: "APP",
		expectKeywords: ["create", "build", "scaffold", "make"],
	},
	{
		file: "app-create-with-existing-picker.scenario.ts",
		id: "app-create-with-existing-picker",
		expectAction: "APP",
		expectKeywords: ["create", "edit", "build"],
	},
	{
		file: "app-create-cancel.scenario.ts",
		id: "app-create-cancel",
		expectAction: "APP",
		expectKeywords: ["create", "cancel"],
	},
] as const;

async function loadScenario(file: string): Promise<LoadedScenario> {
	const full = path.join(SCENARIOS_DIR, file);
	const mod = (await import(pathToFileURL(full).href)) as {
		default: LoadedScenario;
	};
	return mod.default;
}

describe("APP scenarios — contract", () => {
	it.each(EXPECTED)(
		"$file parses, declares the right id, plugin, action, and keywords",
		async ({ file, id, expectAction, expectKeywords }) => {
			const raw = await readFile(path.join(SCENARIOS_DIR, file), "utf8");
			const scen = await loadScenario(file);

			expect(scen).toBeDefined();
			expect(scen.id).toBe(id);
			expect(typeof scen.title).toBe("string");
			expect(scen.title?.length ?? 0).toBeGreaterThan(0);
			expect(Array.isArray(scen.turns)).toBe(true);
			expect((scen.turns?.length ?? 0)).toBeGreaterThan(0);
			expect(Array.isArray(scen.finalChecks)).toBe(true);
			expect((scen.finalChecks?.length ?? 0)).toBeGreaterThan(0);

			// requires.plugins should reference the canonical plugin name.
			expect(scen.requires?.plugins ?? []).toContain(
				"@elizaos/plugin-app-control",
			);

			// At least one finalCheck must reference our action.
			const referencesAction = (scen.finalChecks ?? []).some(
				(c) => c.actionName === expectAction,
			);
			expect(referencesAction).toBe(true);

			// At least one expected keyword appears in the source — guards
			// against a scenario that accidentally swaps verbs.
			const lowered = raw.toLowerCase();
			const matchedKeyword = expectKeywords.some((k) =>
				lowered.includes(k.toLowerCase()),
			);
			expect(matchedKeyword).toBe(true);
		},
	);

	it("scenario inventory matches the expected catalog (no orphans, no missing)", async () => {
		const fs = await import("node:fs/promises");
		const onDisk = (await fs.readdir(SCENARIOS_DIR))
			.filter((f) => f.endsWith(".scenario.ts"))
			.sort();
		const expected = EXPECTED.map((e) => e.file).sort();
		expect(onDisk).toEqual(expected);
	});
});
