import { expect, it, vi } from "vitest";
import type { ExecutionTrace } from "../src/prompt-optimization.ts";
import { AgentRuntime } from "../src/runtime.ts";
import type { UUID } from "../src/types/primitives.ts";

function trace(id: string, runId: UUID, createdAt: number): ExecutionTrace {
	return {
		id,
		runId,
		createdAt,
		traceVersion: 1,
		type: "trace",
		promptKey: "synthetic.prompt",
		modelSlot: "TEXT_LARGE",
		modelId: "synthetic-model",
		templateHash: "synthetic-template",
		schemaFingerprint: "synthetic-schema",
		variant: "baseline",
		parseSuccess: true,
		schemaValid: true,
		validationCodesMatched: true,
		retriesUsed: 0,
		tokenEstimate: 1,
		latencyMs: 1,
		scoreCard: { signals: [], compositeScore: 0 },
	};
}

it("isolates and retires active prompt traces through the runtime", async () => {
	const runtime = new AgentRuntime({ logLevel: "fatal" });
	const firstRun = "10000000-0000-4000-8000-000000000001" as UUID;
	const secondRun = "10000000-0000-4000-8000-000000000002" as UUID;
	const now = Date.now();
	const ttl = 5 * 60 * 1000;
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const first = trace("first", firstRun, now - ttl);
	const latest = trace("latest", firstRun, now);
	const other = trace("other", secondRun, now);
	try {
		runtime.recordPromptTrace(first);
		runtime.recordPromptTrace(other);
		runtime.recordPromptTrace(latest);
		expect(runtime.getActiveTracesForRun(firstRun)).toEqual([first, latest]);
		expect(runtime.getActiveTrace(firstRun)).toBe(latest);
		expect(runtime.getActiveTrace(secondRun)).toBe(other);

		const signal = { source: "fixture", kind: "quality", value: 0.5 };
		runtime.enrichTrace(firstRun, { ...signal, traceId: other.id });
		runtime.enrichTrace(firstRun, { ...signal, traceId: first.id });
		expect(first.scoreCard.signals).toEqual([{ ...signal, traceId: first.id }]);
		expect(first.scoreCard.compositeScore).toBe(0.5);
		expect(latest.scoreCard.signals).toEqual([]);
		expect(other.scoreCard.signals).toEqual([]);

		runtime.enrichTrace(firstRun, signal);
		expect(latest.scoreCard.signals).toEqual([signal]);
		expect(first.scoreCard.signals).toHaveLength(2);
		expect(other.scoreCard.signals).toEqual([]);

		runtime.purgePromptTraces();
		expect(runtime.getActiveTracesForRun(firstRun)).toEqual([first, latest]);
		clock.mockReturnValue(now + 1);
		runtime.purgePromptTraces();
		expect(runtime.getActiveTracesForRun(firstRun)).toEqual([latest]);
		expect(runtime.getActiveTrace(secondRun)).toBe(other);

		runtime.deleteActiveTraceById(latest.id);
		expect(runtime.getActiveTrace(firstRun)).toBeUndefined();
		expect(runtime.getActiveTracesForRun(firstRun)).toEqual([]);
		expect(runtime.getActiveTrace(secondRun)).toBe(other);
		runtime.deleteActiveTrace(secondRun);
		expect(runtime.getActiveTracesForRun(secondRun)).toEqual([]);
	} finally {
		clock.mockRestore();
		await runtime.stop();
	}
});
