import { describe, expect, it } from "vitest";
import { runExtractorPipeline } from "../src/actions/extractor-pipeline";
import type { IAgentRuntime } from "../src/types/runtime";

function recordingRuntime(outputs: string[]) {
	const calls: Array<Record<string, unknown>> = [];
	const runtime = {
		reportError: () => undefined,
		logger: { warn: () => undefined },
		useModel: async (_type: string, params: Record<string, unknown>) => {
			calls.push(params);
			return outputs.shift() ?? "";
		},
	} as unknown as IAgentRuntime;
	return { runtime, calls };
}

const parser = (raw: string) => (raw === "ok" ? raw : null);

describe("runExtractorPipeline provider options", () => {
	it("forwards per-call provider options to the first and repair calls", async () => {
		const { runtime, calls } = recordingRuntime(["bad", "ok"]);
		const providerOptions = { eliza: { thinking: "low" } };
		const result = await runExtractorPipeline({
			runtime,
			prompt: "extract",
			providerOptions,
			parser,
			buildRepairPrompt: () => "repair",
		});

		expect(result).toMatchObject({ parsed: "ok", repaired: true });
		expect(calls.map((call) => call.providerOptions)).toEqual([
			providerOptions,
			providerOptions,
		]);
	});

	it("sends no provider options when the caller gives none", async () => {
		const { runtime, calls } = recordingRuntime(["bad", "ok"]);
		await runExtractorPipeline({
			runtime,
			prompt: "extract",
			parser,
			buildRepairPrompt: () => "repair",
		});

		expect(calls).toHaveLength(2);
		for (const call of calls)
			expect(call).not.toHaveProperty("providerOptions");
	});
});
