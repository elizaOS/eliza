/** Provider-neutral model parameter boundary; no inference or domain effects. */
import { expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../types/runtime";
import { runExtractorPipeline } from "./extractor-pipeline";

it("keeps the explicit trusted system exact through first and repair calls", async () => {
	const useModel = vi
		.fn()
		.mockResolvedValueOnce("invalid")
		.mockResolvedValueOnce("valid");
	const runtime = { useModel } as unknown as IAgentRuntime;
	const result = await runExtractorPipeline({
		runtime,
		prompt: "Selected dialogue and current constraints",
		system: "Canonical persona and USER role",
		parser: (raw) => (raw === "valid" ? raw : null),
		buildRepairPrompt: () => "Complete corrected prompt",
	});
	expect(result.parsed).toBe("valid");
	expect(useModel).toHaveBeenCalledTimes(2);
	expect(useModel.mock.calls.map((call) => call[1])).toEqual([
		{
			prompt: "Selected dialogue and current constraints",
			system: "Canonical persona and USER role",
		},
		{
			prompt: "Complete corrected prompt",
			system: "Canonical persona and USER role",
		},
	]);
});

it("omits the system property entirely when using normal runtime fallback", async () => {
	const useModel = vi.fn().mockResolvedValue("valid");
	await runExtractorPipeline({
		runtime: { useModel } as unknown as IAgentRuntime,
		prompt: "Full legacy prompt",
		parser: (raw) => raw,
	});
	expect(useModel.mock.calls[0][1]).toEqual({ prompt: "Full legacy prompt" });
	expect(Object.hasOwn(useModel.mock.calls[0][1], "system")).toBe(false);
});
