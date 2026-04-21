import { describe, expect, it } from "vitest";
import { hasTextGenerationHandler } from "../services/message";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";

const noopModelHandler = async () => ({ text: "" });

function runtimeWithModels(
	getModelImpl: (modelType: string) => ReturnType<IAgentRuntime["getModel"]>,
): IAgentRuntime {
	return {
		getModel: getModelImpl,
	} as unknown as IAgentRuntime;
}

describe("hasTextGenerationHandler", () => {
	it("returns true when TEXT_LARGE is registered", () => {
		const runtime = runtimeWithModels((modelType) =>
			modelType === ModelType.TEXT_LARGE ? noopModelHandler : undefined,
		);
		expect(hasTextGenerationHandler(runtime)).toBe(true);
	});

	it("returns false when only embeddings and TTS are registered", () => {
		const runtime = runtimeWithModels((modelType) => {
			if (
				modelType === ModelType.TEXT_EMBEDDING ||
				modelType === ModelType.TEXT_TO_SPEECH
			) {
				return noopModelHandler;
			}
			return undefined;
		});
		expect(hasTextGenerationHandler(runtime)).toBe(false);
	});

	it("returns false when no models are registered", () => {
		const runtime = runtimeWithModels(() => undefined);
		expect(hasTextGenerationHandler(runtime)).toBe(false);
	});
});
