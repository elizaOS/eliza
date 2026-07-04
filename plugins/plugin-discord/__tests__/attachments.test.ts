/**
 * Unit tests for the `AttachmentManager` — media type detection and download,
 * against a mocked runtime (no live Discord or network).
 */
import { ContentType, type IAgentRuntime, ModelType } from "@elizaos/core";
import { type Attachment, Collection } from "discord.js";
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

	it("falls back without calling the model when IMAGE_DESCRIPTION is not registered", async () => {
		// 2026-06-10 incident: Cerebras-mode deploys register no IMAGE_DESCRIPTION
		// handler; the graceful-skip path must produce the fallback media (empty
		// text) instead of attempting a doomed vision call.
		const runtime = makeRuntime();
		(runtime.getModel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(
			attachment({
				id: "image-2",
				url: "https://cdn.discordapp.com/image.png",
				name: "image.png",
				contentType: "image/png",
			}),
		);

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(media).toMatchObject({
			id: "image-2",
			contentType: ContentType.IMAGE,
			description: "An image attachment (recognition failed)",
			text: "",
		});
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

	it("describes image media for a Discord attachment collection", async () => {
		// End-to-end entry point: Discord delivers attachments as a Collection,
		// so processAttachments must surface described image media for the agent.
		const runtime = makeRuntime();
		const manager = new AttachmentManager(runtime);

		const image = attachment({
			id: "image-3",
			url: "https://cdn.discordapp.com/image.png",
			name: "image.png",
			contentType: "image/png",
		});
		const collection = new Collection<string, Attachment>([[image.id, image]]);

		const media = await manager.processAttachments(collection);

		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.IMAGE_DESCRIPTION,
			"https://cdn.discordapp.com/image.png",
		);
		expect(media).toHaveLength(1);
		expect(media[0]).toMatchObject({
			id: "image-3",
			contentType: ContentType.IMAGE,
			source: "Image",
			title: "image title",
			description: "image description",
			text: "image description",
		});
	});
});
