import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MESSAGE_SOURCE = path.resolve(
	import.meta.dirname,
	"../services/message.ts",
);

describe("message service benchmark integration contracts", () => {
	it("centralizes benchmark mode detection through hasInboundBenchmarkContext", async () => {
		const source = await readFile(MESSAGE_SOURCE, "utf8");

		expect(source).toContain(
			"function hasInboundBenchmarkContext(message: Memory)",
		);
		// Inline benchmark-flag inspection at call sites is forbidden — go through
		// the helper.
		expect(source).not.toContain("metadata?.benchmarkContext;\n\t\tconst");
	});

	it("forces CONTEXT_BENCH into the provider list when benchmark context is present", async () => {
		const source = await readFile(MESSAGE_SOURCE, "utf8");

		expect(source).toContain("hasInboundBenchmarkContext(message)");
		expect(source).toContain('"CONTEXT_BENCH"');
	});
});
