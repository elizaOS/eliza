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

	it("forces the planner to require a tool call only when both the env opt-in and an inbound benchmark signal are present", async () => {
		const source = await readFile(MESSAGE_SOURCE, "utf8");

		// The helper exists and is the single place this decision is made.
		expect(source).toContain(
			"function isBenchmarkForcingToolCall(message: Memory)",
		);
		// Env-var opt-in is required (default behavior unchanged for chat).
		expect(source).toContain("MILADY_BENCH_FORCE_TOOL_CALL");
		// Detection must also require an inbound benchmark signal so a
		// co-resident chat process is unaffected even if the env var leaks.
		expect(source).toContain('content.source === "benchmark"');
		expect(source).toContain("contentMetadata.benchmark");
		// The planner gate consults the helper alongside Stage 1's requiresTool.
		expect(source).toContain("isBenchmarkForcingToolCall(args.message)");
		expect(source).toContain(
			"messageHandler.plan.requiresTool === true || benchmarkForcingToolCall",
		);
	});
});
