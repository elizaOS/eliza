import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MESSAGE_SOURCE = path.resolve(
	import.meta.dirname,
	"../services/message.ts",
);

describe("message service benchmark integration contracts", () => {
	it("centralizes benchmark mode detection through a single helper", async () => {
		const source = await readFile(MESSAGE_SOURCE, "utf8");

		expect(source).toContain('function isBenchmarkMode(state: Pick<State, "values">)');
		expect(source).not.toContain("state.values.benchmark_has_context === true");
		expect(source).not.toContain("state.values.benchmark_has_context !== true");
		expect(source.match(/isBenchmarkMode\(state\)/g)).toHaveLength(2);
	});

	it("still gates both action forcing and continuation suppression on benchmark mode", async () => {
		const source = await readFile(MESSAGE_SOURCE, "utf8");

		expect(source).toContain("const benchmarkMode = isBenchmarkMode(state);");
		expect(source).toContain('responseContent.providers = ["CONTEXT_BENCH"]');
		expect(source).toContain("!isBenchmarkMode(state)");
	});
});
