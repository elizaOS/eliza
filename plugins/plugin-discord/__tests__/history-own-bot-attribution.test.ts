/**
 * History reads and backfill attribute this account's own bot messages to the
 * agent, the same entity the send path stores them under, while other bots
 * keep their own derived entities.
 */

import { ChannelType, stringToUuid, type UUID } from "@elizaos/core";
import type { Message } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
	buildMemoryFromMessage,
	ensureConnectionsForMessages,
	type HistoryServiceInternals,
} from "../discord-history.ts";

const AGENT_ID = stringToUuid("discord-history-agent") as UUID;
const BOT_USER_ID = "1000000000000000001";
const OTHER_BOT_ID = "1000000000000000002";
const USER_ID = "1000000000000000003";

const guild = { id: "1000000000000000010", name: "Guild", ownerId: USER_ID };
const channel = {
	id: "1000000000000000020",
	type: DiscordChannelType.GuildText,
	guild,
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
			logger: { debug: vi.fn(), warn: vi.fn() },
		} as unknown as HistoryServiceInternals["runtime"],
		messageManager: undefined,
		resolveDiscordEntityId: (userId: string) =>
			stringToUuid(`discord-${userId}`) as UUID,
		isOwnerAliasedDiscordUser: () => false,
		getChannelType: async () => ChannelType.GROUP,
		isGuildTextBasedChannel: (c): c is never => Boolean(c),
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
});
