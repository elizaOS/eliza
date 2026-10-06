import { describe, expect, it, vi } from "vitest";
import { runExtractorPipeline } from "../src/actions/extractor-pipeline.js";
import { ModelType } from "../src/types/model.js";
import type { IAgentRuntime } from "../src/types/runtime.js";

function runtimeFor(outputs: unknown[]) {
	return {
		useModel: vi.fn(async () => {
			const output = outputs.shift();
			if (output instanceof Error) throw output;
			return output;
		}),
		reportError: vi.fn(),
		logger: { warn: vi.fn() },
	} as unknown as IAgentRuntime;
}

describe("extractor response format contract", () => {
	it("forwards the JSON opt-in and canonical system on both attempts", async () => {
		const runtime = runtimeFor(["invalid", '{"restoreContext":true}']);
		const result = await runExtractorPipeline({
			runtime,
			prompt: "Extract JSON",
			system: "canonical system",
			responseFormat: { type: "json_object" },
			parser: (raw) => (raw.startsWith("{") ? JSON.parse(raw) : null),
			buildRepairPrompt: (raw) => `Repair JSON: ${raw}`,
		});
		expect(result).toEqual({
			parsed: { restoreContext: true },
			raw: '{"restoreContext":true}',
			repaired: true,
		});
		expect(vi.mocked(runtime.useModel).mock.calls).toEqual([
			[
				ModelType.TEXT_LARGE,
				{
					prompt: "Extract JSON",
					system: "canonical system",
					responseFormat: { type: "json_object" },
				},
			],
			[
				ModelType.TEXT_LARGE,
				{
					prompt: "Repair JSON: invalid",
					system: "canonical system",
					responseFormat: { type: "json_object" },
				},
			],
		]);
	});

	it("keeps generic non-JSON parsers and repair calls in text mode by default", async () => {
		const runtime = runtimeFor(["invalid", "minimal"]);
		const result = await runExtractorPipeline({
			runtime,
			prompt: "Classify intensity",
			modelType: ModelType.TEXT_SMALL,
			parser: (raw) => (raw === "minimal" ? raw : null),
			buildRepairPrompt: () => "Return an intensity",
		});
		expect(result).toEqual({
			parsed: "minimal",
			raw: "minimal",
			repaired: true,
		});
		expect(vi.mocked(runtime.useModel).mock.calls).toEqual([
			[ModelType.TEXT_SMALL, { prompt: "Classify intensity" }],
			[ModelType.TEXT_SMALL, { prompt: "Return an intensity" }],
		]);
	});

	it.each([false, true])(
		"reports and propagates transport failures without further attempts (repair=%s)",
		async (repair) => {
			const failure = new Error("provider unavailable");
			const runtime = runtimeFor(repair ? ["invalid", failure] : [failure]);
			await expect(
				runExtractorPipeline({
					runtime,
					prompt: "Extract JSON",
					responseFormat: { type: "json_object" },
					parser: () => null,
					buildRepairPrompt: () => "Repair JSON",
				}),
			).rejects.toBe(failure);
			expect(runtime.useModel).toHaveBeenCalledTimes(repair ? 2 : 1);
			expect(runtime.reportError).toHaveBeenCalledWith(
				"ExtractorPipeline.model",
				failure,
				{ modelType: ModelType.TEXT_LARGE },
			);
		},
	);

	it.each([false, true])(
		"rejects non-text provider output without changing failure semantics (repair=%s)",
		async (repair) => {
			const runtime = runtimeFor(repair ? ["invalid", {}] : [{}]);
			await expect(
				runExtractorPipeline({
					runtime,
					prompt: "Extract JSON",
					responseFormat: { type: "json_object" },
					parser: () => null,
					buildRepairPrompt: () => "Repair JSON",
				}),
			).rejects.toMatchObject({ code: "EXTRACTOR_NON_TEXT_RESPONSE" });
			expect(runtime.useModel).toHaveBeenCalledTimes(repair ? 2 : 1);
			expect(runtime.reportError).toHaveBeenCalledOnce();
		},
	);
});
