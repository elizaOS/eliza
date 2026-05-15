import { describe, expect, it } from "vitest";
import { ModelType } from "../../../types/model.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { runtimeModelContextProvider } from "./runtimeModelContext.ts";

function makeRuntime(
	settings: Record<string, string | undefined>,
	overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key] ?? null,
		models: new Map([
			[ModelType.RESPONSE_HANDLER, [{ provider: "openai" }]],
			[ModelType.ACTION_PLANNER, [{ provider: "openai" }]],
		]),
		...overrides,
	} as unknown as IAgentRuntime;
}

describe("runtimeModelContextProvider", () => {
	it("exposes configured runtime model slots for self-model questions", async () => {
		const runtime = makeRuntime({
			OPENAI_SMALL_MODEL: "gpt-oss-120b",
			OPENAI_MEDIUM_MODEL: "gpt-oss-120b",
			OPENAI_LARGE_MODEL: "gpt-oss-120b",
			ELIZA_DEFAULT_AGENT_TYPE: "opencode",
			ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
		});

		const result = await runtimeModelContextProvider.get(
			runtime,
			{} as never,
			{} as never,
		);

		expect(result.text).toContain("Response handler model: gpt-oss-120b");
		expect(result.text).toContain("Action planner model: gpt-oss-120b");
		expect(result.text).toContain("Default coding sub-agent: opencode");
		expect(result.text).toContain("OpenCode model: gpt-oss-120b");
		expect(result.text).not.toContain("Claude 3.5");
		expect(result.data?.responseHandlerModel).toBe("gpt-oss-120b");
	});

	it("uses the runtime resolver when available", async () => {
		const runtime = makeRuntime({}, {
			resolveProviderModelString: (modelType: string) =>
				modelType === ModelType.RESPONSE_HANDLER
					? "resolved-response-model"
					: `resolved-${modelType}`,
		} as Partial<IAgentRuntime>);

		const result = await runtimeModelContextProvider.get(
			runtime,
			{} as never,
			{} as never,
		);

		expect(result.data?.responseHandlerModel).toBe("resolved-response-model");
		expect(result.text).toContain(
			"Action planner model: resolved-ACTION_PLANNER",
		);
	});
});
