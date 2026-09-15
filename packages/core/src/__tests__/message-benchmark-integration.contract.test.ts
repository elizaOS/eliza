/** Exercises benchmark admission through real provider composition and request-scoped tool-call policy. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import {
	composeResponseState,
	isBenchmarkForcingToolCall,
} from "../services/message/provider-state";
import type { Memory } from "../types";

function message(content: Memory["content"] = { text: "answer this" }): Memory {
	return {
		id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		entityId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		roomId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
		content,
	};
}
afterEach(() => vi.unstubAllEnvs());
describe("message service benchmark integration", () => {
	it("composes complete benchmark context only for the request carrying it", async () => {
		const runtime = new AgentRuntime({
			character: { name: "benchmark-contract", bio: [] },
		});
		const context = "Complete benchmark evidence\n".repeat(1000);
		runtime.registerProvider({
			name: "CONTEXT_BENCH",
			dynamic: true,
			get: async (_runtime, input) => ({
				text: String(input.metadata?.benchmarkContext),
				values: {},
				data: {},
			}),
		});
		const inbound = message();
		inbound.metadata = { benchmarkContext: context };
		const benchmark = await composeResponseState(runtime, inbound, true);
		expect(benchmark.text).toContain(context);
		const ordinary = await composeResponseState(
			runtime,
			{ ...message(), id: "dddddddd-dddd-dddd-dddd-dddddddddddd" },
			true,
		);
		expect(ordinary.text).not.toContain(context);
	});
	it("requires both process opt-in and an inbound benchmark signal", () => {
		const benchmark = message({ text: "find a result", source: "benchmark" });
		vi.stubEnv("ELIZA_BENCH_FORCE_TOOL_CALL", "0");
		expect(isBenchmarkForcingToolCall(benchmark)).toBe(false);
		vi.stubEnv("ELIZA_BENCH_FORCE_TOOL_CALL", "1");
		expect(isBenchmarkForcingToolCall(benchmark)).toBe(true);
		expect(isBenchmarkForcingToolCall(message())).toBe(false);
	});
	it("honors metadata admission and the vending benchmark exemption", () => {
		vi.stubEnv("ELIZA_BENCH_FORCE_TOOL_CALL", "1");
		expect(
			isBenchmarkForcingToolCall(
				message({ text: "act", metadata: { benchmark: "tool-use" } }),
			),
		).toBe(true);
		expect(
			isBenchmarkForcingToolCall(
				message({
					text: "act",
					source: "benchmark",
					metadata: { benchmark: "vending-bench" },
				}),
			),
		).toBe(false);
	});
});
