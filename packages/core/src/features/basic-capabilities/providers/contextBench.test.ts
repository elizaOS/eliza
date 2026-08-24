/**
 * Unit tests for the CONTEXT_BENCH provider's generated contract and metadata
 * handling. The real provider runs against deterministic inputs without mocks.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../../types/index.ts";
import { contextBenchProvider } from "./contextBench.ts";

const runtime = {} as IAgentRuntime;
const state = { values: {}, data: {}, text: "" } as State;

function messageWithMetadata(metadata: unknown): Memory {
	return {
		content: { text: "Run the benchmark" },
		metadata,
	} as unknown as Memory;
}

describe("contextBenchProvider", () => {
	it("exposes the generated provider contract and turn-scoped gates", () => {
		expect(contextBenchProvider).toMatchObject({
			name: "CONTEXT_BENCH",
			position: 5,
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
		expect(contextBenchProvider.description).toBeTruthy();
	});

	it.each([
		["missing metadata", undefined],
		["null metadata", null],
		["metadata without the benchmark key", {}],
		["an undefined benchmark value", { benchmarkContext: undefined }],
		["a non-string benchmark value", { benchmarkContext: 42 }],
		["a whitespace-only benchmark value", { benchmarkContext: " \n\t " }],
	])("returns the empty result for %s", async (_label, metadata) => {
		await expect(
			contextBenchProvider.get(runtime, messageWithMetadata(metadata), state),
		).resolves.toEqual({
			text: "",
			values: { benchmark_has_context: false },
			data: {},
		});
	});

	it("trims and surfaces a non-empty benchmark context", async () => {
		await expect(
			contextBenchProvider.get(
				runtime,
				messageWithMetadata({
					benchmarkContext:
						"  Customer prefers dark mode.\nKeep contrast high.  ",
				}),
				state,
			),
		).resolves.toEqual({
			text: "# Benchmark Context\nCustomer prefers dark mode.\nKeep contrast high.",
			values: { benchmark_has_context: true },
			data: {
				benchmarkContext: "Customer prefers dark mode.\nKeep contrast high.",
			},
		});
	});
});
