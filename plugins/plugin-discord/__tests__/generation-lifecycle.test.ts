/**
 * Exercises Discord generation ownership through the real message dispatch
 * path: service shutdown aborts model work, drains the turn, and prevents late
 * or newly accepted replies without relying on a wall-clock deadline.
 */
import type { Content, Memory, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "../messages";
import type { ICompatRuntime, IDiscordService } from "../types";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const INBOUND_MEMORY: Memory = {
	id: "12345678-1234-1234-1234-123456789abc" as UUID,
	entityId: "87654321-4321-4321-4321-cba987654321" as UUID,
	agentId: AGENT_ID,
	roomId: "11111111-2222-3333-4444-555555555555" as UUID,
	content: { text: "keep working until the owner stops", source: "discord" },
};

interface SentMessage {
	content?: string;
}

function makeChannel(sends: SentMessage[]) {
	return {
		id: "777000000000000000",
		type: DiscordChannelType.DM,
		isThread: () => false,
		send: vi.fn(async (options: SentMessage) => {
			sends.push(options);
			return {
				id: "990000000000000001",
				createdTimestamp: Date.now(),
				attachments: new Map(),
				...options,
			};
		}),
		sendTyping: vi.fn(async () => {}),
	};
}

function makeMessage(channel: unknown): DiscordMessage {
	return {
		id: "666000000000000000",
		content: "keep working until the owner stops",
		createdTimestamp: Date.now(),
		author: {
			id: "555000111222333444",
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
		mentions: {
			users: new Map(),
			repliedUser: undefined,
			has: () => true,
		},
	} as unknown as DiscordMessage;
}

function makeService(client: unknown): IDiscordService {
	return {
		client,
		accountId: "default",
		getChannelType: async () => ChannelType.DM,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "off",
		},
		buildMemoryFromMessage: async () => INBOUND_MEMORY,
	} as unknown as IDiscordService;
}

function makeRuntime(
	handleMessage: (
		callback: (content: Content) => Promise<unknown>,
		signal: AbortSignal,
	) => Promise<unknown>,
): ICompatRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getSetting: (key: string) =>
			key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS" ? "false" : undefined,
		getService: () => null,
		ensureConnection: async () => {},
		getMemoryById: async () => null,
		createMemory: async (memory: Memory) => memory.id,
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				_message: Memory,
				callback: (content: Content) => Promise<unknown>,
				options?: { abortSignal?: AbortSignal },
			) => {
				if (!options?.abortSignal) {
					throw new Error("Discord did not provide generation ownership");
				}
				return handleMessage(callback, options.abortSignal);
			},
		},
	} as unknown as ICompatRuntime;
}

describe("Discord generation lifecycle", () => {
	it("aborts and drains in-flight generation on manager stop without a timeout reply", async () => {
		const sends: SentMessage[] = [];
		const channel = makeChannel(sends);
		let capturedSignal: AbortSignal | undefined;
		let capturedCallback: ((content: Content) => Promise<unknown>) | undefined;
		let dispatches = 0;
		const runtime = makeRuntime((callback, signal) => {
			dispatches += 1;
			capturedSignal = signal;
			capturedCallback = callback;
			return new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		});
		const manager = new MessageManager(
			makeService({ user: { id: "888000000000000000" } }),
			runtime,
		);

		const handling = manager.handleMessage(makeMessage(channel));
		await vi.waitFor(() => expect(capturedSignal).toBeDefined());

		await manager.stop();
		await handling;

		expect(capturedSignal?.aborted).toBe(true);
		expect(dispatches).toBe(1);
		expect(sends).toEqual([]);
		expect(runtime.logger.error).not.toHaveBeenCalled();

		await expect(
			capturedCallback?.({ text: "late response", source: "discord" }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(sends).toEqual([]);

		await manager.handleMessage(makeMessage(channel));
		expect(dispatches).toBe(1);
	});

	it("keeps a completed turn live until shutdown and emits its response once", async () => {
		const sends: SentMessage[] = [];
		const channel = makeChannel(sends);
		let capturedSignal: AbortSignal | undefined;
		const runtime = makeRuntime(async (callback, signal) => {
			capturedSignal = signal;
			await callback({ text: "completed response", source: "discord" });
		});
		const manager = new MessageManager(
			makeService({
				user: { id: "888000000000000000" },
				users: { fetch: vi.fn() },
			}),
			runtime,
		);

		await manager.handleMessage(makeMessage(channel));

		expect(capturedSignal?.aborted).toBe(false);
		expect(sends).toHaveLength(1);
		expect(sends[0]?.content).toBe("completed response");

		await manager.stop();
		expect(capturedSignal?.aborted).toBe(false);
	});
});
