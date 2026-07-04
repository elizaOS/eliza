/**
 * Source-text contract test: reads services/message.ts and asserts benchmark-mode
 * detection stays centralized in hasInboundBenchmarkContext /
 * isBenchmarkForcingToolCall (no inline benchmark-flag inspection at call sites),
 * that benchmark context forces CONTEXT_BENCH into the provider list, and that
 * the planner requires a tool call only when both the env opt-in and an inbound
 * benchmark signal are present. Static assertions over the file — no runtime.
 */
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
		expect(source).toContain("ELIZA_BENCH_FORCE_TOOL_CALL");
		// Detection must also require an inbound benchmark signal so a
		// co-resident chat process is unaffected even if the env var leaks.
		expect(source).toContain('content.source === "benchmark"');
		expect(source).toContain("contentMetadata.benchmark");
		// The planner gate consults the helper alongside Stage 1's requiresTool.
		expect(source).toContain("isBenchmarkForcingToolCall(args.message)");
		// requiresTool is still consulted (now via the named-action guard), and the
		// benchmark signal is OR'd in so a benchmark turn forces a tool regardless.
		expect(source).toContain("messageHandler.plan.requiresTool === true");
		expect(source).toContain("|| benchmarkForcingToolCall");
	});
});
