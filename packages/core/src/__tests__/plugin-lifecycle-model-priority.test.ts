/**
 * Plugin model ownership must follow the registered record, not its position:
 * the model dispatcher sorts handlers by priority, so a higher-priority plugin
 * registered later lands ahead of earlier lower-priority handlers.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import { ModelType } from "../types/model";

function createRuntimeWithProviders() {
	const runtime = new AgentRuntime({
		character: { name: "model-priority", bio: ["test"] },
		logLevel: "fatal",
	});
	const localHandler = async () => "from-local";
	const cloudHandler = async () => "from-cloud";
	const localPlugin = {
		name: "local-llm",
		description: "default-priority model provider",
		models: { [ModelType.TEXT_LARGE]: localHandler },
	};
	const cloudPlugin = {
		name: "cloud-llm",
		description: "higher-priority model provider",
		priority: 50,
		models: { [ModelType.TEXT_LARGE]: cloudHandler },
	};
	return { runtime, localHandler, cloudHandler, localPlugin, cloudPlugin };
}

function textLargeProviders(runtime: AgentRuntime): string[] | undefined {
	return (
		runtime as unknown as { models: Map<string, { provider: string }[]> }
	).models
		.get(ModelType.TEXT_LARGE)
		?.map((model) => model.provider);
}

describe("plugin model ownership with prioritized providers", () => {
	it("unloading the higher-priority plugin removes its own model handler", async () => {
		const { runtime, localHandler, localPlugin, cloudPlugin } =
			createRuntimeWithProviders();
		await runtime.registerPlugin(localPlugin);
		await runtime.registerPlugin(cloudPlugin);

		expect(
			runtime.getPluginOwnership("cloud-llm")?.models.map((m) => m.provider),
		).toEqual(["cloud-llm"]);
		await runtime.unloadPlugin("cloud-llm");

		expect(textLargeProviders(runtime)).toEqual(["local-llm"]);
		expect(runtime.getModel(ModelType.TEXT_LARGE)).toBe(localHandler);
	});

	it("reloading the higher-priority plugin keeps one handler per provider", async () => {
		const { runtime, localHandler, localPlugin, cloudPlugin } =
			createRuntimeWithProviders();
		await runtime.registerPlugin(localPlugin);
		await runtime.registerPlugin(cloudPlugin);

		await runtime.reloadPlugin(cloudPlugin);
		expect(textLargeProviders(runtime)).toEqual(["cloud-llm", "local-llm"]);

		await runtime.unloadPlugin("cloud-llm");
		expect(textLargeProviders(runtime)).toEqual(["local-llm"]);
		expect(runtime.getModel(ModelType.TEXT_LARGE)).toBe(localHandler);
	});
});
