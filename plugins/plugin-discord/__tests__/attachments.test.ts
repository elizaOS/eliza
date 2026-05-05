import { ContentType, type IAgentRuntime, ModelType } from "@elizaos/core";
import type { Attachment } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function createAttachment(overrides: Partial<Attachment> = {}): Attachment {
	return {
		id: "attachment-1",
		url: "https://cdn.discordapp.com/attachments/1/file.txt",
		name: "file.txt",
		size: 1234,
		contentType: "text/plain",
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
		getService: vi.fn(() => null),
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

afterEach(() => {
	vi.unstubAllGlobals();
});

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
			contentType: ContentType.IMAGE,
			title: "Image Attachment",
			description: "An image attachment (recognition failed)",
			text: "",
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
			contentType: ContentType.IMAGE,
			description: "A described image",
			text: "A described image",
		});
	});
});

describe("AttachmentManager text attachments", () => {
	it("reads non-plain text MIME attachments", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("# Notes\nsecret: saffron-anchor")),
		);
		const runtime = createRuntime();
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(
			createAttachment({
				name: "notes.md",
				contentType: "text/markdown; charset=utf-8",
			}),
		);

		expect(media).toMatchObject({
			source: "Plaintext",
			contentType: ContentType.DOCUMENT,
			text: "# Notes\nsecret: saffron-anchor",
		});
	});

	it("reads octet-stream uploads when the filename is text-like", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"secret":"json-anchor"}')),
		);
		const runtime = createRuntime();
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(
			createAttachment({
				name: "payload.json",
				contentType: "application/octet-stream",
			}),
		);

		expect(media).toMatchObject({
			source: "Plaintext",
			contentType: ContentType.DOCUMENT,
			text: '{"secret":"json-anchor"}',
		});
	});

	it("does not fetch unknown binary-looking attachments as text", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const runtime = createRuntime();
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(
			createAttachment({
				name: "archive.bin",
				contentType: "application/octet-stream",
			}),
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(media).toMatchObject({
			source: "Generic",
			text: "",
		});
	});
});

describe("AttachmentManager non-text media fallbacks", () => {
	it("marks audio attachments without transcription as unreadable media", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
		);
		const runtime = createRuntime({
			useModel: vi.fn(async () => ""),
		});
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(
			createAttachment({
				name: "voice.wav",
				contentType: "audio/wav",
			}),
		);

		expect(media).toMatchObject({
			source: "Audio",
			contentType: ContentType.AUDIO,
			description: "User-uploaded audio/video attachment (no transcription available)",
			text: "",
		});
	});

	it("marks video attachments as unreadable when the video service is unavailable", async () => {
		const runtime = createRuntime();
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(
			createAttachment({
				name: "clip.webm",
				contentType: "video/webm",
			}),
		);

		expect(media).toMatchObject({
			source: "Video",
			contentType: ContentType.VIDEO,
			description:
				"Could not process video attachment because the required service is not available.",
			text: "",
		});
	});

	it("marks failed PDF conversion as unreadable document content", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]))),
		);
		const runtime = createRuntime();
		const manager = new AttachmentManager(runtime);

		const media = await manager.processAttachment(
			createAttachment({
				name: "document.pdf",
				contentType: "application/pdf",
			}),
		);

		expect(media).toMatchObject({
			source: "PDF",
			contentType: ContentType.DOCUMENT,
			description: "A PDF document that could not be converted to text",
			text: "",
		});
	});
});
