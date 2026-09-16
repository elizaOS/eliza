/** Exercises benchmark admission through real provider composition and ordinary plugin registration. */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import { composeResponseState } from "../../../../plugins/plugin-assistant/src/services/message/provider-state.ts";
import type { Memory } from "../types";

function message(content: Memory["content"] = { text: "answer this" }): Memory {
	return {
		id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		entityId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		roomId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
		content,
	};
}
describe("message service benchmark integration", () => {
	it("composes complete benchmark context only for the request carrying it", async () => {
		const runtime = new AgentRuntime({
			character: { name: "benchmark-contract", bio: [] },
		});
		const context = "Complete benchmark evidence\n".repeat(1000);
		runtime.registerProvider({
			name: "CONTEXT_BENCH",
			dynamic: true,
			alwaysInResponseState: true,
			get: async (_runtime, input) => ({
				text:
					typeof input.metadata?.benchmarkContext === "string"
						? input.metadata.benchmarkContext
						: "",
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
});
