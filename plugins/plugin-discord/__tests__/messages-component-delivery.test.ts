/**
 * Discord outbound delivery preserves rendered interaction components across
 * direct-message and draft-stream paths. These tests exercise the manager layer
 * because that is where connector policy, streaming, chunking, and transport
 * payload construction converge.
 *
 * Drives the REAL `MessageManager.handleMessage` (inbound guards, DM policy,
 * memory build, response callback) with a stub runtime whose message service
 * invokes the response callback with a `[CHOICE]` reply, and captures the
 * exact `user.send` / `channel.send` payloads. Only the discord.js SDK
 * objects are stubbed; no bot token, no network.
 */
import type { Content, Memory, UUID } from "@elizaos/core";
import { ChannelType, decodeCallback } from "@elizaos/core";
import type {
	ActionRowBuilder,
	Message as DiscordMessage,
	MessageActionRowComponentBuilder,
} from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

interface CapturedSend {
	content?: string;
	files?: unknown[];
	components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const noop = () => {};

const CHOICE_REPLY: Content = {
	text: "Pick one:\n[CHOICE:approve id=c1]\nyes=Yes, ship it\nno=Cancel\n[/CHOICE]",
	channelType: "DM",
};

function makeRuntime(
	replyContent: Content,
	settings: Record<string, string> = {},
): { runtime: ICompatRuntime; errors: string[] } {
	const errors: string[] = [];
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: noop,
			info: noop,
			warn: noop,
			// A callback failure surfaces as logger.error + a "please retry"
			// fallback send; collecting errors lets tests assert the delivery
			// path completed cleanly instead of silently degrading.
			error: (...args: unknown[]) => {
				errors.push(JSON.stringify(args));
			},
		},
		getSetting: (key: string) =>
			key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS"
				? "false"
				: (settings[key] ?? undefined),
		getService: () => null,
		ensureConnection: async () => {},
		// The callback persists outbound memories via createDiscordMessageMemoryOnce.
		getMemoryById: async () => null,
		createMemory: async (memory: Memory) => memory.id,
		// Invoking the production response callback with a crafted reply reaches
		// the same outbound branches that connector messages use at runtime.
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				_message: Memory,
				callback: (content: Content) => Promise<unknown>,
			) => {
				await callback(structuredClone(replyContent));
			},
		},
	} as unknown as ICompatRuntime;
	return { runtime, errors };
}

function makeSentMessage(id: string, options: CapturedSend) {
	return {
		id,
		content: options.content ?? "",
		url: `https://discord.com/channels/@me/1/${id}`,
		createdTimestamp: Date.now(),
		attachments: { size: 0 },
		edit: async () => ({ id }),
	};
}

function makeInbound(
	channel: unknown,
	authorId: string,
	messageId = "666000000000000000",
): DiscordMessage {
	return {
		id: messageId,
		content: "which one?",
		createdTimestamp: Date.now(),
		author: {
			id: authorId,
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
		},
		member: null,
		channel,
		guild: undefined,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: { users: new Map(), repliedUser: undefined },
	} as unknown as DiscordMessage;
}

const INBOUND_MEMORY: Memory = {
	id: "12345678-1234-1234-1234-123456789abc" as UUID,
	entityId: "87654321-4321-4321-4321-cba987654321" as UUID,
	agentId: AGENT_ID,
	roomId: "11111111-2222-3333-4444-555555555555" as UUID,
	content: { text: "which one?", source: "discord" },
};

function makeDiscordService(client: unknown): IDiscordService {
	return {
		client,
		accountId: "default",
		getChannelType: async () => ChannelType.DM,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "first",
		},
		buildMemoryFromMessage: async () => INBOUND_MEMORY,
	} as unknown as IDiscordService;
}

function rowJson(component: unknown): {
	type: number;
	components: Array<{ custom_id: string; label: string }>;
} {
	return (component as { toJSON: () => ReturnType<typeof rowJson> }).toJSON();
}

describe("Discord outbound component delivery (#14527)", () => {
	it("carries rendered components on a DM send", async () => {
		const dmSends: CapturedSend[] = [];
		const dmUser = {
			id: "555000111222333444",
			send: async (options: CapturedSend) => {
				dmSends.push(options);
				return makeSentMessage("990000000000000001", options);
			},
		};

		const client = {
			user: { id: "888000000000000000" },
			users: { fetch: async () => dmUser },
		};

		const channel = {
			id: "777000000000000000",
			type: DiscordChannelType.DM,
			isThread: () => false,
			send: async () => {
				throw new Error(
					"DM replies must go through user.send, not channel.send",
				);
			},
		};

		const { runtime, errors } = makeRuntime(CHOICE_REPLY);
		const manager = new MessageManager(makeDiscordService(client), runtime);
		await manager.handleMessage(makeInbound(channel, dmUser.id));

		expect(errors).toEqual([]);
		expect(dmSends).toHaveLength(1);
		const sent = dmSends[0];
		expect(sent.content).toBe("Pick one:");
		expect(sent.components).toHaveLength(1);
		const row = rowJson(sent.components?.[0]);
		expect(row.type).toBe(1);
		expect(row.components.map((c) => c.label)).toEqual([
			"Yes, ship it",
			"Cancel",
		]);
		expect(decodeCallback(row.components[0].custom_id)).toEqual({
			kind: "reply",
			value: "yes",
		});
	});

	it("passes callback text through untouched — sanitization lives at the shared core boundary (#15888)", async () => {
		// The Discord-local pre-send sanitizer is gone: text reaching the
		// connector callback is already sanitized upstream in @elizaos/core, and
		// Discord must NOT run a second pass. The old local pass corrupted `$$`
		// inside fences (string-replacement restore) and truncated replies at an
		// inline `<tool_call>` mention — this payload would not survive it.
		const passThrough: Content = {
			text: "Run:\n```bash\nkill -9 $$\n```\nThe `<tool_call>` tag is machine syntax.",
			channelType: "DM",
		};
		const dmSends: CapturedSend[] = [];
		const dmUser = {
			id: "555000111222333444",
			send: async (options: CapturedSend) => {
				dmSends.push(options);
				return makeSentMessage("990000000000000002", options);
			},
		};
		const client = {
			user: { id: "888000000000000000" },
			users: { fetch: async () => dmUser },
		};
		const channel = {
			id: "777000000000000000",
			type: DiscordChannelType.DM,
			isThread: () => false,
			send: async () => {
				throw new Error(
					"DM replies must go through user.send, not channel.send",
				);
			},
		};

		const { runtime, errors } = makeRuntime(passThrough);
		const manager = new MessageManager(makeDiscordService(client), runtime);
		await manager.handleMessage(makeInbound(channel, dmUser.id));

		expect(errors).toEqual([]);
		expect(dmSends).toHaveLength(1);
		expect(dmSends[0].content).toBe(passThrough.text);
	});

	it("carries rendered components through draft-stream finalize", async () => {
		const channelSends: CapturedSend[] = [];
		const channel = {
			id: "777000000000000000",
			type: DiscordChannelType.DM,
			isThread: () => false,
			send: async (options: CapturedSend) => {
				channelSends.push(options);
				return makeSentMessage(
					`99000000000000000${channelSends.length}`,
					options,
				);
			},
		};

		const client = {
			user: { id: "888000000000000000" },
			users: {
				fetch: async () => {
					throw new Error(
						"draft-stream replies must finalize on the channel, not re-fetch the user",
					);
				},
			},
		};

		const { runtime, errors } = makeRuntime(CHOICE_REPLY, {
			DISCORD_DRAFT_STREAMING: "true",
		});
		const manager = new MessageManager(makeDiscordService(client), runtime);
		await manager.handleMessage(
			makeInbound(channel, "555000111222333444", "666000000000000001"),
		);

		expect(errors).toEqual([]);
		expect(channelSends).toHaveLength(1);
		const sent = channelSends[0];
		expect(sent.content).toBe("Pick one:");
		expect(sent.components).toHaveLength(1);
		const row = rowJson(sent.components?.[0]);
		expect(row.components.map((c) => c.label)).toEqual([
			"Yes, ship it",
			"Cancel",
		]);
	});
});
