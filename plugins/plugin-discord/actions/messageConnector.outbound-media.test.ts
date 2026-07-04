/**
 * Unit tests for outbound media on the Discord connector (#8876) — each `Media`
 * on a sent message must map to a Discord `AttachmentBuilder`. Mocked service
 * and discord.js client.
 */
import {
	type Content,
	ContentType,
	type IAgentRuntime,
	type Media,
} from "@elizaos/core";
import { AttachmentBuilder } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAccountClientPool } from "../account-client-pool";
import { DEFAULT_ACCOUNT_ID } from "../accounts";
import { DiscordService } from "../service";
import { buildOutboundDiscordAttachment } from "../utils";

// Outbound media coverage for the Discord connector (#8876): when the agent
// generates/sends a message that carries `Media` attachments, the connector
// send path must map each `Media` to a Discord `AttachmentBuilder` and pass it
// to `channel.send({ files })`. Exercised with a fully mocked discord.js client
// so it runs offline (no live Discord), mirroring messageConnector.test.ts.

function createDiscordConnectorTestService<
	TProperties extends Record<string, unknown>,
>(properties: TProperties): DiscordService & TProperties {
	return Object.assign(
		Object.create(DiscordService.prototype),
		properties,
	) as DiscordService & TProperties;
}

function createRuntime() {
	return {
		agentId: "agent-1",
		logger: {
			info: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getRoom: vi.fn(),
		ensureConnection: vi.fn().mockResolvedValue(undefined),
		createMemory: vi.fn().mockResolvedValue(undefined),
	} as unknown as IAgentRuntime;
}

function setup(sendImpl?: (options: unknown) => unknown) {
	const runtime = createRuntime();
	const send = vi.fn(
		sendImpl ??
			(async (options: unknown) => ({
				id: "444444444444444444",
				content:
					typeof options === "object" && options
						? String((options as { content?: string }).content ?? "")
						: "",
				attachments: {
					size: Array.isArray((options as { files?: unknown[] }).files)
						? (options as { files: unknown[] }).files.length
						: 0,
				},
				url: "https://discord.com/channels/111/222/444",
				createdTimestamp: 123,
			})),
	);
	const channel = {
		id: "222222222222222222",
		name: "general",
		guild: { id: "111111111111111111", name: "Eliza" },
		isTextBased: () => true,
		isVoiceBased: () => false,
		send,
	};
	const client = {
		isReady: () => true,
		channels: { fetch: vi.fn().mockResolvedValue(channel) },
		user: { id: "999999999999999999", username: "bot", displayName: "Bot" },
	};
	const accountPool = new DiscordAccountClientPool();
	accountPool.set({
		accountId: DEFAULT_ACCOUNT_ID,
		account: { id: DEFAULT_ACCOUNT_ID, token: "token", enabled: true },
		client,
		settings: {},
		dynamicChannelIds: new Set<string>(),
		clientReadyPromise: null,
		loginFailed: false,
	} as never);
	const service = createDiscordConnectorTestService({
		runtime,
		accountPool,
		defaultAccountId: DEFAULT_ACCOUNT_ID,
		getChannelType: vi.fn().mockResolvedValue("GROUP"),
	});
	return { runtime, service, send };
}

const TARGET = {
	source: "discord",
	channelId: "222222222222222222",
} as const;

function media(over: Partial<Media>): Media {
	return { id: "m1", url: "https://cdn.example.com/cat.png", ...over } as Media;
}

describe("Discord connector outbound media", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("maps a Media attachment to a Discord AttachmentBuilder on send (with text)", async () => {
		const { runtime, service, send } = setup();
		const content: Content = {
			text: "Here you go",
			attachments: [media({ contentType: "image", title: "cat.png" })],
		};
		await service.handleSendMessage(runtime, TARGET as never, content);

		expect(send).toHaveBeenCalledTimes(1);
		const opts = send.mock.calls[0][0] as {
			content?: string;
			files?: unknown[];
		};
		expect(opts.content).toBe("Here you go");
		expect(opts.files).toHaveLength(1);
		expect(opts.files?.[0]).toBeInstanceOf(AttachmentBuilder);
		const file = opts.files?.[0] as AttachmentBuilder;
		expect(file.attachment).toBe("https://cdn.example.com/cat.png");
		expect(file.name).toMatch(/\.png$/);
	});

	it("sends an attachment-only message (no text) as files with no content", async () => {
		const { runtime, service, send } = setup();
		const content: Content = {
			text: "",
			attachments: [
				media({
					id: "vid",
					url: "https://cdn.example.com/clip.mp4",
					contentType: "video",
				}),
			],
		};
		await service.handleSendMessage(runtime, TARGET as never, content);

		expect(send).toHaveBeenCalledTimes(1);
		const opts = send.mock.calls[0][0] as {
			content?: string;
			files?: unknown[];
		};
		expect(opts.content).toBeUndefined();
		expect(opts.files).toHaveLength(1);
		expect(opts.files?.[0]).toBeInstanceOf(AttachmentBuilder);
	});

	it("maps multiple attachments to multiple AttachmentBuilders", async () => {
		const { runtime, service, send } = setup();
		const content: Content = {
			text: "two files",
			attachments: [
				media({ id: "a", url: "https://cdn.example.com/a.png" }),
				media({ id: "b", url: "https://cdn.example.com/b.pdf" }),
			],
		};
		await service.handleSendMessage(runtime, TARGET as never, content);

		const opts = send.mock.calls[0][0] as { files?: unknown[] };
		expect(opts.files).toHaveLength(2);
		expect(opts.files?.every((f) => f instanceof AttachmentBuilder)).toBe(true);
	});

	it("skips a Media that has no url (cannot be sent) but still sends the text", async () => {
		const { runtime, service, send } = setup();
		const content: Content = {
			text: "no file here",
			attachments: [media({ id: "x", url: "" })],
		};
		await service.handleSendMessage(runtime, TARGET as never, content);

		expect(send).toHaveBeenCalledTimes(1);
		const opts = send.mock.calls[0][0] as {
			content?: string;
			files?: unknown[];
		};
		expect(opts.content).toBe("no file here");
		// No sendable media → files omitted (undefined), not an empty array push.
		expect(opts.files).toBeUndefined();
	});

	it("uploads generated video bytes through the guarded media fetch path", async () => {
		const runtime = createRuntime();
		const fetchMock = vi.fn(async () => {
			return new Response(Buffer.from("video-bytes"), {
				status: 200,
				headers: { "content-type": "video/mp4" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const file = await buildOutboundDiscordAttachment(
			media({
				id: "generated-video",
				url: "https://cdn.example.com/v1/videos/abc/content",
				contentType: ContentType.VIDEO,
				source: "media-generation",
				title: "clip.mp4",
			}),
			runtime,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(file).toBeInstanceOf(AttachmentBuilder);
		expect(Buffer.isBuffer(file.attachment)).toBe(true);
		expect((file.attachment as Buffer).toString()).toBe("video-bytes");
		expect(file.name).toBe("clip.mp4");
	});

	it("does not fetch private non-generated media URLs server-side", async () => {
		const runtime = createRuntime();
		const fetchMock = vi.fn(async () => {
			throw new Error("must not fetch");
		});
		vi.stubGlobal("fetch", fetchMock);

		const privateUrl = "http://192.168.255.164:8080/private/clip.mp4";
		const file = await buildOutboundDiscordAttachment(
			media({
				id: "user-video",
				url: privateUrl,
				contentType: ContentType.VIDEO,
				title: "clip.mp4",
			}),
			runtime,
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(file.attachment).toBe(privateUrl);
	});
});
