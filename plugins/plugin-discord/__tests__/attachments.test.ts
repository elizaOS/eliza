import { type IAgentRuntime, ModelType } from "@elizaos/core";
import type { Attachment } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { AttachmentManager } from "../attachments";

function createImageAttachment(
	overrides: Partial<Attachment> = {},
): Attachment {
	return {
		id: "attachment-1",
		url: "https://cdn.discordapp.com/attachments/1/image.png",
		name: "image.png",
		size: 1234,
		contentType: "image/png",
		...overrides,
	} as Attachment;
}

function createRuntime(
	overrides: {
		disabled?: string | boolean | null;
		hasImageDescriptionHandler?: boolean;
		useModel?: IAgentRuntime["useModel"];
	} = {},
): IAgentRuntime {
	return {
		agentId: "agent-1",
		getSetting: vi.fn((key: string) =>
			key === "DISABLE_IMAGE_DESCRIPTION" ? (overrides.disabled ?? null) : null,
		),
		getModel: vi.fn((modelType: string) =>
			modelType === ModelType.IMAGE_DESCRIPTION &&
			overrides.hasImageDescriptionHandler
				? vi.fn()
				: undefined,
		),
		useModel:
			overrides.useModel ??
			vi.fn(async () => ({
				title: "Detected image",
				description: "A described image",
			})),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

describe("AttachmentManager image attachments", () => {
	it("does not call IMAGE_DESCRIPTION when no handler is registered", async () => {
		const runtime = createRuntime({ hasImageDescriptionHandler: false });
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(createImageAttachment());

		expect(runtime.getModel).toHaveBeenCalledWith(ModelType.IMAGE_DESCRIPTION);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(media).toMatchObject({
			id: "attachment-1",
			source: "Image",
			title: "Image Attachment",
			description: "An image attachment (recognition failed)",
		});
		expect(runtime.logger.error).not.toHaveBeenCalled();
	});

	it("does not call IMAGE_DESCRIPTION when image descriptions are disabled", async () => {
		const runtime = createRuntime({
			disabled: "true",
			hasImageDescriptionHandler: true,
		});
		const manager = new AttachmentManager(runtime);

		await manager.processAttachment(createImageAttachment());

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.logger.error).not.toHaveBeenCalled();
	});

	it("uses IMAGE_DESCRIPTION when a handler is registered and enabled", async () => {
		const runtime = createRuntime({ hasImageDescriptionHandler: true });
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(createImageAttachment());

		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.IMAGE_DESCRIPTION,
			"https://cdn.discordapp.com/attachments/1/image.png",
		);
		expect(media).toMatchObject({
			title: "Detected image",
			description: "A described image",
			text: "A described image",
		});
	});
});
