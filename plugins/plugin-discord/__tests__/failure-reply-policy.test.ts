/**
 * FAILURE_REPLY_POLICY on the Discord generation-failure path.
 *
 * When generation times out or the provider throws, the connector used to
 * post a canned "I timed out while generating that reply. Please retry." /
 * "I hit a provider issue ..." into whatever channel the inbound came from.
 * In a guild channel that is public noise: every reader sees the outage and
 * nobody can act on it (observed live: five identical timeout posts into a
 * shared channel during a 29h provider outage). Under the default `dm-only`
 * policy a public room now gets the error reaction only; DMs keep the text.
 *
 * Drives the REAL `MessageManager.handleMessage` with a hanging or throwing
 * messageService; only the discord.js surface is stubbed.
 */
import type { Content, Memory, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const CLIENT_ID = "888000000000000000";
const GUILD_ID = "999000000000000000";
const noop = () => {};

const INBOUND_MEMORY: Memory = {
	id: "12345678-1234-1234-1234-123456789abc" as UUID,
	entityId: "87654321-4321-4321-4321-cba987654321" as UUID,
	agentId: AGENT_ID,
	roomId: "11111111-2222-3333-4444-555555555555" as UUID,
	content: { text: "a real question that takes a while", source: "discord" },
};

interface Sent {
	content?: string;
}

type LogEntry = [Record<string, unknown>, string];

const canonicalRoomMethods = (type: ChannelType) => ({
	getRoom: async () => ({ id: INBOUND_MEMORY.roomId, type }),
	getParticipantsForRoom: async () => [INBOUND_MEMORY.entityId, AGENT_ID],
	reportError: noop,
});

/**
 * `mode` selects how the dispatch dies: `hang` never resolves (the generation
 * timeout fires), `throw` rejects immediately (provider issue).
 */
function makeRuntime(options: {
	mode: "hang" | "throw";
	roomType: ChannelType;
	settings?: Record<string, string>;
}): { runtime: ICompatRuntime; infos: LogEntry[]; warns: LogEntry[] } {
	const infos: LogEntry[] = [];
	const warns: LogEntry[] = [];
	const settings: Record<string, string> = {
		ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
		DISCORD_GENERATION_TIMEOUT_MS: "30000",
		...(options.settings ?? {}),
	};
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: noop,
			info: (...args: unknown[]) => infos.push(args as LogEntry),
			warn: (...args: unknown[]) => warns.push(args as LogEntry),
			error: noop,
		},
		getSetting: (key: string) => settings[key],
		getService: () => null,
		ensureConnection: async () => {},
		...canonicalRoomMethods(options.roomType),
		getMemoryById: async () => null,
		createMemory: async (memory: Memory) => memory.id,
		messageService: {
			handleMessage: (
				_runtime: unknown,
				_message: Memory,
				_callback: (content: Content) => Promise<unknown>,
			) => {
				if (options.mode === "throw") {
					return Promise.reject(new Error("provider exploded"));
				}
				return new Promise<never>(() => {});
			},
		},
	} as unknown as ICompatRuntime;
	return { runtime, infos, warns };
}

function makeChannel(kind: "dm" | "guild" | "thread", sends: Sent[]) {
	const base = {
		id: "777000000000000000",
		client: { user: { id: CLIENT_ID } },
		send: async (options: Sent) => {
			sends.push(options);
			return { id: `99000000000000000${sends.length}`, ...options };
		},
		sendTyping: async () => {},
	};
	if (kind === "dm") {
		return { ...base, type: DiscordChannelType.DM, isThread: () => false };
	}
	const guild = {
		id: GUILD_ID,
		name: "Test Guild",
		ownerId: "444000000000000000",
		members: { cache: new Map([[CLIENT_ID, { id: CLIENT_ID }]]) },
	};
	return {
		...base,
		type:
			kind === "thread"
				? DiscordChannelType.PublicThread
				: DiscordChannelType.GuildText,
		name: "development",
		guild,
		isThread: () => kind === "thread",
		permissionsFor: () => ({ has: () => true }),
	};
}

function makeDiscordService(roomType: ChannelType): IDiscordService {
	return {
		client: { user: { id: CLIENT_ID } },
		accountId: "default",
		getChannelType: async () => roomType,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			shouldRespondOnlyToMentions: false,
			replyToMode: "off",
		},
		buildMemoryFromMessage: async () => INBOUND_MEMORY,
	} as unknown as IDiscordService;
}

function makeInbound(
	channel: ReturnType<typeof makeChannel>,
	reactionEvents: string[],
): DiscordMessage {
	const activeReactions = new Map<
		string,
		{ users: { remove: () => Promise<void> } }
	>();
	const guild = "guild" in channel ? channel.guild : undefined;
	const users = new Map<string, { id: string }>();
	// Always address the bot so a guild room reaches dispatch on the
	// respond-only-to-mentions safe side; the policy must still silence it.
	users.set(CLIENT_ID, { id: CLIENT_ID });
	return {
		id: "666000000000000000",
		content: `<@${CLIENT_ID}> a real question that takes a while`,
		createdTimestamp: Date.now(),
		author: {
			id: "555000111222333444",
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
			displayAvatarURL: () => "https://cdn.example/avatar.png",
		},
		member: { displayName: "Tester" },
		channel,
		client: { user: { id: CLIENT_ID } },
		react: async (emoji: string) => {
			reactionEvents.push(`add:${emoji}`);
			activeReactions.set(emoji, {
				users: {
					remove: async () => {
						reactionEvents.push(`remove:${emoji}`);
						activeReactions.delete(emoji);
					},
				},
			});
		},
		reactions: { resolve: (emoji: string) => activeReactions.get(emoji) },
		guild,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: {
			users,
			repliedUser: undefined,
			has: () => true,
		},
	} as unknown as DiscordMessage;
}

async function runFailure(options: {
	channel: "dm" | "guild" | "thread";
	mode: "hang" | "throw";
	settings?: Record<string, string>;
}) {
	const sends: Sent[] = [];
	const reactionEvents: string[] = [];
	const roomType =
		options.channel === "dm" ? ChannelType.DM : ChannelType.GROUP;
	const channel = makeChannel(options.channel, sends);
	const { runtime, infos, warns } = makeRuntime({
		mode: options.mode,
		roomType,
		settings: options.settings,
	});
	const manager = new MessageManager(makeDiscordService(roomType), runtime);
	const handled = manager.handleMessage(makeInbound(channel, reactionEvents));
	await vi.advanceTimersByTimeAsync(0);
	if (options.mode === "hang") {
		await vi.advanceTimersByTimeAsync(30_000);
	}
	await handled;
	await vi.advanceTimersByTimeAsync(0);
	return { sends, reactionEvents, infos, warns };
}

const failureTexts = (sends: Sent[]) =>
	sends.filter(
		(s) =>
			String(s.content).includes("timed out") ||
			String(s.content).includes("provider issue"),
	);

describe("Discord FAILURE_REPLY_POLICY", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe("default (dm-only)", () => {
		it("guild channel timeout: no channel.send, error reaction set, suppression logged", async () => {
			const { sends, reactionEvents, infos } = await runFailure({
				channel: "guild",
				mode: "hang",
			});
			expect(failureTexts(sends)).toHaveLength(0);
			expect(sends).toHaveLength(0);
			expect(reactionEvents).toContain("add:❌");
			const suppressed = infos.find(
				([ctx]) => ctx.code === "DISCORD_FAILURE_REPLY_SUPPRESSED_PUBLIC",
			);
			expect(suppressed).toBeDefined();
			expect(suppressed?.[0]).toMatchObject({
				channelId: "777000000000000000",
				cause: "timeout",
				policy: "dm-only",
				reason: "policy-dm-only-public-room",
				isDm: false,
			});
		});

		it("guild channel provider error: no channel.send, cause=provider", async () => {
			const { sends, reactionEvents, infos } = await runFailure({
				channel: "guild",
				mode: "throw",
			});
			expect(sends).toHaveLength(0);
			expect(reactionEvents).toContain("add:❌");
			const suppressed = infos.find(
				([ctx]) => ctx.code === "DISCORD_FAILURE_REPLY_SUPPRESSED_PUBLIC",
			);
			expect(suppressed?.[0]).toMatchObject({ cause: "provider" });
		});

		it("public thread timeout: silent like its parent guild channel", async () => {
			const { sends, reactionEvents } = await runFailure({
				channel: "thread",
				mode: "hang",
			});
			expect(sends).toHaveLength(0);
			expect(reactionEvents).toContain("add:❌");
		});

		it("DM timeout: failure reply still sent", async () => {
			const { sends, reactionEvents, infos } = await runFailure({
				channel: "dm",
				mode: "hang",
			});
			const replies = failureTexts(sends);
			expect(replies).toHaveLength(1);
			expect(replies[0].content).toContain("timed out");
			expect(reactionEvents).toContain("add:❌");
			expect(
				infos.some(
					([ctx]) => ctx.code === "DISCORD_FAILURE_REPLY_SUPPRESSED_PUBLIC",
				),
			).toBe(false);
		});

		it("DM provider error: failure reply still sent", async () => {
			const { sends } = await runFailure({ channel: "dm", mode: "throw" });
			const replies = failureTexts(sends);
			expect(replies).toHaveLength(1);
			expect(replies[0].content).toContain("provider issue");
		});
	});

	describe("FAILURE_REPLY_POLICY=all", () => {
		it("guild channel timeout: legacy behavior, failure reply sent", async () => {
			const { sends, reactionEvents } = await runFailure({
				channel: "guild",
				mode: "hang",
				settings: { FAILURE_REPLY_POLICY: "all" },
			});
			const replies = failureTexts(sends);
			expect(replies).toHaveLength(1);
			expect(replies[0].content).toContain("timed out");
			expect(reactionEvents).toContain("add:❌");
		});
	});

	describe("FAILURE_REPLY_POLICY=off", () => {
		it("DM timeout: silent too, error reaction still set", async () => {
			const { sends, reactionEvents, infos } = await runFailure({
				channel: "dm",
				mode: "hang",
				settings: { FAILURE_REPLY_POLICY: "off" },
			});
			expect(sends).toHaveLength(0);
			expect(reactionEvents).toContain("add:❌");
			const suppressed = infos.find(
				([ctx]) => ctx.code === "DISCORD_FAILURE_REPLY_SUPPRESSED_PUBLIC",
			);
			expect(suppressed?.[0]).toMatchObject({
				policy: "off",
				reason: "policy-off",
				isDm: true,
			});
		});
	});

	describe("unrecognized value", () => {
		it("fails closed to dm-only: guild silent, DM replies, warning logged", async () => {
			const guild = await runFailure({
				channel: "guild",
				mode: "hang",
				settings: { FAILURE_REPLY_POLICY: "loud" },
			});
			expect(guild.sends).toHaveLength(0);
			const dm = await runFailure({
				channel: "dm",
				mode: "hang",
				settings: { FAILURE_REPLY_POLICY: "loud" },
			});
			expect(failureTexts(dm.sends)).toHaveLength(1);
		});
	});
});
