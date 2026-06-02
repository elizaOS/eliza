import { ContentType, type IAgentRuntime, ModelType } from "@elizaos/core";
import type { Attachment } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentManager } from "../attachments";

function makeRuntime(): IAgentRuntime {
	return {
		agentId: "11111111-1111-1111-1111-111111111111",
		getModel: vi.fn(() => vi.fn()),
		getSetting: vi.fn(() => undefined),
		getService: vi.fn(() => null),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
		useModel: vi.fn(async () => ({
			description: "image description",
			title: "image title",
		})),
	} as unknown as IAgentRuntime;
}

function attachment(overrides: Partial<Attachment>): Attachment {
	return {
		id: "attachment-1",
		url: "https://cdn.discordapp.com/attachment.txt",
		name: "attachment.txt",
		contentType: "text/plain",
		...overrides,
	} as Attachment;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AttachmentManager", () => {
	it("does not fetch or model non-remote attachment URLs", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const runtime = makeRuntime();
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(
			attachment({
				id: "hostile-file",
				url: "file:///etc/passwd",
				name: "secrets.txt",
				contentType: "text/plain",
			}),
		);

		expect(media).toMatchObject({
			id: "hostile-file",
			url: "file:///etc/passwd",
			title: "Generic Attachment",
			source: "Generic",
			description: "A generic attachment",
			text: "",
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				attachmentId: "hostile-file",
				url: "file:///etc/passwd",
			}),
			"Skipping attachment with non-remote URL",
		);
	});

	it("uses the image description model for normal remote image URLs", async () => {
		const runtime = makeRuntime();
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(
			attachment({
				id: "image-1",
				url: "https://cdn.discordapp.com/image.png",
				name: "image.png",
				contentType: "image/png",
			}),
		);

		expect(runtime.getModel).toHaveBeenCalledWith(ModelType.IMAGE_DESCRIPTION);
		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.IMAGE_DESCRIPTION,
			"https://cdn.discordapp.com/image.png",
		);
		expect(media).toMatchObject({
			id: "image-1",
			contentType: ContentType.IMAGE,
			title: "image title",
			text: "image description",
		});
	});
});
