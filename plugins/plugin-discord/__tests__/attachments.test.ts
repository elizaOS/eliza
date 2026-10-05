/**
 * Unit tests for the `AttachmentManager` — media type detection, download, and
 * the bounded inbound attachment cache — against a mocked runtime (no live
 * Discord or network).
 */
import { ContentType, type IAgentRuntime, ModelType } from "@elizaos/core";
import { type Attachment, Collection } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AttachmentManager,
	DISCORD_ATTACHMENT_CACHE_MAX_ENTRIES,
	DISCORD_ATTACHMENT_CACHE_TTL_MS,
} from "../attachments";

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

describe("AttachmentManager inbound cache", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("hits the cache on a second process of the same attachment id", async () => {
		const runtime = makeRuntime();
		const manager = new AttachmentManager(runtime);
		const first = attachment({
			id: "image-cache",
			url: "https://cdn.discordapp.com/image.png?ex=1",
			name: "image.png",
			contentType: "image/png",
		});

		const firstMedia = await manager.processAttachment(first);
		expect(firstMedia?.text).toBe("image description");
		expect(runtime.useModel).toHaveBeenCalledTimes(1);

		const secondMedia = await manager.processAttachment(first);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(secondMedia?.id).toBe("image-cache");
		expect(secondMedia?.text).toBeUndefined();
	});

	it("does not duplicate work for different signed URLs with the same id", async () => {
		const runtime = makeRuntime();
		const manager = new AttachmentManager(runtime);

		await manager.processAttachment(
			attachment({
				id: "stable-id",
				url: "https://cdn.discordapp.com/image.png?ex=111&is=222",
				name: "image.png",
				contentType: "image/png",
			}),
		);
		await manager.processAttachment(
			attachment({
				id: "stable-id",
				url: "https://cdn.discordapp.com/image.png?ex=999&is=888",
				name: "image.png",
				contentType: "image/png",
			}),
		);

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("does not retain extracted transcript text in the cached entry", async () => {
		const runtime = makeRuntime();
		const manager = new AttachmentManager(runtime);
		const first = await manager.processAttachment(
			attachment({
				id: "described",
				url: "https://cdn.discordapp.com/image.png",
				name: "image.png",
				contentType: "image/png",
			}),
		);
		expect(first?.text).toBe("image description");

		const cached = await manager.processAttachment(
			attachment({
				id: "described",
				url: "https://cdn.discordapp.com/image.png?ex=rotated",
				name: "image.png",
				contentType: "image/png",
			}),
		);
		expect(cached).not.toHaveProperty("text");
	});

	it("evicts the oldest id once the cache cap is exceeded", async () => {
		const runtime = makeRuntime();
		const manager = new AttachmentManager(runtime);

		for (let i = 0; i < DISCORD_ATTACHMENT_CACHE_MAX_ENTRIES + 1; i++) {
			await manager.processAttachment(
				attachment({
					id: `img-${i}`,
					url: `https://cdn.discordapp.com/${i}.png`,
					name: `${i}.png`,
					contentType: "image/png",
				}),
			);
		}
		expect(runtime.useModel).toHaveBeenCalledTimes(
			DISCORD_ATTACHMENT_CACHE_MAX_ENTRIES + 1,
		);

		await manager.processAttachment(
			attachment({
				id: "img-0",
				url: "https://cdn.discordapp.com/0.png",
				name: "0.png",
				contentType: "image/png",
			}),
		);
		expect(runtime.useModel).toHaveBeenCalledTimes(
			DISCORD_ATTACHMENT_CACHE_MAX_ENTRIES + 2,
		);
	});

	it("evicts expired entries on the TTL sweep", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const runtime = makeRuntime();
		const manager = new AttachmentManager(runtime);

		await manager.processAttachment(
			attachment({
				id: "ttl-image",
				url: "https://cdn.discordapp.com/image.png",
				name: "image.png",
				contentType: "image/png",
			}),
		);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);

		vi.setSystemTime(
			new Date("2026-01-01T00:00:00Z").getTime() +
				DISCORD_ATTACHMENT_CACHE_TTL_MS +
				1,
		);
		await manager.processAttachment(
			attachment({
				id: "ttl-image",
				url: "https://cdn.discordapp.com/image.png?ex=later",
				name: "image.png",
				contentType: "image/png",
			}),
		);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});
});
