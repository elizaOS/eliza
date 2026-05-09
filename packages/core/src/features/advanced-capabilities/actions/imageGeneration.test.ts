import { describe, expect, it, vi } from "vitest";
import type { HandlerOptions, IAgentRuntime, Memory } from "../../../types";
import { ModelType } from "../../../types";
import { generateImageAction } from "./imageGeneration";

function makeRuntime(hasImageModel: boolean): IAgentRuntime {
	return {
		agentId: "agent-id",
		getModel: vi.fn((modelType: string) =>
			hasImageModel && modelType === ModelType.IMAGE ? vi.fn() : undefined,
		),
	} as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text },
	} as Memory;
}

describe("generateImageAction", () => {
	it("is unavailable when no image generation model is registered", async () => {
		await expect(
			generateImageAction.validate(
				makeRuntime(false),
				makeMessage("generate an image of a workspace on fire"),
			),
		).resolves.toBe(false);
	});

	it("validates image generation requests when an image model is registered", async () => {
		await expect(
			generateImageAction.validate(
				makeRuntime(true),
				makeMessage("generate an image of a workspace on fire"),
			),
		).resolves.toBe(true);
	});

	it("honors planned prompt parameters only when image generation is configured", async () => {
		const options = {
			parameters: { prompt: "a dramatic office meltdown" },
		} satisfies HandlerOptions;

		await expect(
			generateImageAction.validate(
				makeRuntime(false),
				makeMessage("please do it"),
				undefined,
				options,
			),
		).resolves.toBe(false);

		await expect(
			generateImageAction.validate(
				makeRuntime(true),
				makeMessage("please do it"),
				undefined,
				options,
			),
		).resolves.toBe(true);
	});
});
