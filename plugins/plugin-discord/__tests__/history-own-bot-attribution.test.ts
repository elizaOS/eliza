/**
 * History reads and backfill attribute this account's own bot messages to the
 * agent, the same entity the send path stores them under, while other bots
 * keep their own derived entities.
 */

import {
	ChannelType,
	createUniqueUuid,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import type { Message } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordAccountClientPool } from "../account-client-pool.ts";
import { DEFAULT_ACCOUNT_ID } from "../accounts.ts";
import {
	buildMemoryFromMessage,
	ensureConnectionsForMessages,
	type HistoryServiceInternals,
} from "../discord-history.ts";
import { DiscordService } from "../service.ts";

const AGENT_ID = stringToUuid("discord-history-agent") as UUID;
const BOT_USER_ID = "1000000000000000001";
const OTHER_BOT_ID = "1000000000000000002";
const USER_ID = "1000000000000000003";

const guild = { id: "1000000000000000010", name: "Guild", ownerId: USER_ID };
const channel = {
	id: "1000000000000000020",
	name: "general",
	type: DiscordChannelType.GuildText,
	guild,
	isTextBased: () => true,
	isVoiceBased: () => false,
};

function discordMessage(id: string, authorId: string, bot: boolean): Message {
	return {
		id,
		author: {
			id: authorId,
			username: `user-${authorId}`,
			globalName: `User ${authorId}`,
			bot,
			displayAvatarURL: () => "https://cdn.example/avatar.png",
		},
		channel,
		guild,
		content: `message from ${authorId}`,
		createdTimestamp: 1_700_000_000_000,
		url: `https://discord.com/channels/${guild.id}/${channel.id}/${id}`,
		reference: undefined,
	} as unknown as Message;
}

function service() {
	const ensureConnections = vi.fn(async () => undefined);
	const internals: HistoryServiceInternals = {
		accountId: "discord-account-1",
		client: {
			user: { id: BOT_USER_ID },
		} as unknown as HistoryServiceInternals["client"],
		runtime: {
			agentId: AGENT_ID,
			ensureConnections,
			getSetting: vi.fn(() => undefined),
			logger: { debug: vi.fn(), warn: vi.fn() },
		} as unknown as HistoryServiceInternals["runtime"],
		messageManager: undefined,
		resolveDiscordEntityId: (userId: string) =>
			stringToUuid(`discord-${userId}`) as UUID,
		isOwnerAliasedDiscordUser: () => false,
		getChannelType: async () => ChannelType.GROUP,
		isGuildTextBasedChannel: (candidate): candidate is never =>
			Boolean(candidate),
	};
	return { internals, ensureConnections };
}

describe("Discord history author attribution", () => {
	it("maps this account's bot to the agent and other bots to their own entity", async () => {
		const { internals } = service();

		const own = await buildMemoryFromMessage(
			internals,
			discordMessage("1000000000000000101", BOT_USER_ID, true),
		);
		const other = await buildMemoryFromMessage(
			internals,
			discordMessage("1000000000000000102", OTHER_BOT_ID, true),
		);
		const user = await buildMemoryFromMessage(
			internals,
			discordMessage("1000000000000000103", USER_ID, false),
		);

		expect(own?.entityId).toBe(AGENT_ID);
		expect(other?.entityId).toBe(stringToUuid(`discord-${OTHER_BOT_ID}`));
		expect(user?.entityId).toBe(stringToUuid(`discord-${USER_ID}`));
	});

	it("backfills the agent entity without seeding it with the bot's identity", async () => {
		const { internals, ensureConnections } = service();

		await ensureConnectionsForMessages(internals, [
			discordMessage("1000000000000000201", BOT_USER_ID, true),
			discordMessage("1000000000000000202", USER_ID, false),
		]);

		expect(ensureConnections).toHaveBeenCalledTimes(1);
		const [entities] = ensureConnections.mock.calls[0] as unknown as [
			Array<{ id: UUID; names: string[]; metadata: Record<string, unknown> }>,
		];
		expect(entities).toEqual([
			expect.objectContaining({ id: AGENT_ID, names: [], metadata: {} }),
			expect.objectContaining({
				id: stringToUuid(`discord-${USER_ID}`),
				names: [`user-${USER_ID}`, `User ${USER_ID}`],
			}),
		]);
	});

	it("attributes the cached chat context for this account's bot to the agent", async () => {
		const { internals } = service();
		const own = discordMessage("1000000000000000301", BOT_USER_ID, true);
		const other = discordMessage("1000000000000000302", OTHER_BOT_ID, true);
		const fetchedChannel = {
			...channel,
			messages: {
				cache: new Map([
					[own.id, own],
					[other.id, other],
				]),
			},
		};
		const client = {
			user: { id: BOT_USER_ID },
			channels: { fetch: vi.fn(async () => fetchedChannel) },
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
		const discordService = Object.assign(
			Object.create(DiscordService.prototype),
			{
				runtime: internals.runtime,
				accountPool,
				defaultAccountId: DEFAULT_ACCOUNT_ID,
				ownerDiscordUserIds: [] as string[],
			},
		) as DiscordService;

		const context = await discordService.getConnectorChatContext(
			{
				source: "discord",
				accountId: DEFAULT_ACCOUNT_ID,
				channelId: channel.id,
			},
			{ runtime: internals.runtime },
		);

		expect(context?.recentMessages).toEqual([
			expect.objectContaining({ entityId: AGENT_ID, text: own.content }),
			expect.objectContaining({
				entityId: createUniqueUuid(internals.runtime, OTHER_BOT_ID),
				text: other.content,
			}),
		]);
	});
});
