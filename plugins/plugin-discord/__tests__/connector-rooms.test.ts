/**
 * listConnectorRooms completeness: the connector must return EVERY text channel
 * across ALL cached guilds — list_channels/list_connections derive channel and
 * muted counts from the returned length, so a cap here silently corrupts both.
 * Real DiscordService.prototype method over a fake discord.js guild cache.
 */
import type {
	IAgentRuntime,
	MessageConnectorQueryContext,
	UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DiscordService } from "../service.ts";

const runtime = {
	agentId: "00000000-0000-0000-0000-000000000001" as UUID,
} as unknown as IAgentRuntime;

interface FakeGuild {
	id: string;
	name: string;
	channels: { cache: Map<string, unknown> };
}

function fakeTextChannel(id: string, name: string, guild: FakeGuild) {
	return {
		id,
		name,
		guild,
		parentId: null,
		isTextBased: () => true,
		isVoiceBased: () => false,
		isThread: () => false,
	};
}

function fakeGuild(
	id: string,
	name: string,
	channelCount: number,
	firstChannelId: number,
): FakeGuild {
	const guild: FakeGuild = { id, name, channels: { cache: new Map() } };
	for (let i = 0; i < channelCount; i++) {
		const channelId = String(firstChannelId + i);
		guild.channels.cache.set(
			channelId,
			fakeTextChannel(channelId, `chan-${id}-${i}`, guild),
		);
	}
	return guild;
}

function serviceWithGuilds(guilds: FakeGuild[]): DiscordService {
	const client = {
		guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
	};
	return Object.assign(Object.create(DiscordService.prototype), {
		runtime,
		client,
		defaultAccountId: "default",
		accountPool: { get: () => null, getDefault: () => null },
	}) as DiscordService;
}

describe("DiscordService.listConnectorRooms — cross-guild completeness", () => {
	it("returns every text channel across all guilds, past 50", async () => {
		const service = serviceWithGuilds([
			fakeGuild("100", "Guild A", 40, 1000),
			fakeGuild("200", "Guild B", 35, 2000),
		]);
		const targets = await service.listConnectorRooms({
			runtime,
		} as MessageConnectorQueryContext);

		expect(targets).toHaveLength(75);
		// Both guilds are fully represented — nothing from the second guild is
		// dropped by a flat cross-guild cap.
		expect(targets.filter((t) => t.target.serverId === "100")).toHaveLength(40);
		expect(targets.filter((t) => t.target.serverId === "200")).toHaveLength(35);
	});

	it("returns an empty list when no guilds are cached (fresh login, no servers)", async () => {
		const service = serviceWithGuilds([]);
		const targets = await service.listConnectorRooms({
			runtime,
		} as MessageConnectorQueryContext);

		expect(targets).toEqual([]);
	});

	it("reports an unavailable selected account instead of no targets", async () => {
		const service = serviceWithGuilds([]);
		const context = {
			runtime,
			target: { source: "discord", accountId: "missing-account" },
		} as MessageConnectorQueryContext;
		const expected = {
			code: "DISCORD_ACCOUNT_NOT_INITIALIZED",
			context: { accountId: "missing-account" },
		};

		await expect(service.listConnectorRooms(context)).rejects.toMatchObject(
			expected,
		);
		await expect(
			service.resolveConnectorTargets("general", context),
		).rejects.toMatchObject(expected);
	});

	it("still dedupes and drops non-text channels", async () => {
		const guild = fakeGuild("300", "Guild C", 3, 3000);
		guild.channels.cache.set("voice-1", {
			id: "voice-1",
			name: "voice",
			guild,
			parentId: null,
			isTextBased: () => true,
			isVoiceBased: () => true,
			isThread: () => false,
		});
		const service = serviceWithGuilds([guild]);
		const targets = await service.listConnectorRooms({
			runtime,
		} as MessageConnectorQueryContext);

		expect(targets).toHaveLength(3);
		expect(targets.every((t) => t.target.channelId !== "voice-1")).toBe(true);
	});
});

describe("DiscordService.leaveConnectorChannel", () => {
	function serviceWithChannel(allowedChannelIds?: string[]) {
		const guild: FakeGuild = {
			id: "100",
			name: "Guild A",
			channels: { cache: new Map() },
		};
		const channel = {
			...fakeTextChannel("C1", "general", guild),
			messages: {},
		};
		guild.channels.cache.set("C1", channel);
		const client = {
			guilds: { cache: new Map([["100", guild]]) },
			channels: { cache: guild.channels.cache, fetch: async () => channel },
		};
		return Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			client,
			defaultAccountId: "default",
			accountPool: { get: () => null, getDefault: () => null },
			allowedChannelIds,
			dynamicChannelIds: new Set<string>(),
		}) as DiscordService;
	}
	const leave = (service: DiscordService) =>
		service.leaveConnectorChannel(runtime, {
			target: { source: "discord", channelId: "C1" },
		} as never);

	it("fails when no channel allowlist is set, because the bot keeps listening", async () => {
		const service = serviceWithChannel();
		await expect(leave(service)).rejects.toMatchObject({
			code: "DISCORD_LEAVE_NO_CHANNEL_ALLOWLIST",
		});
		expect(service.isChannelAllowed("C1")).toBe(true);
	});

	it("fails for a channel listed in CHANNEL_IDS", async () => {
		const service = serviceWithChannel(["C1"]);
		await expect(leave(service)).rejects.toMatchObject({
			code: "DISCORD_LEAVE_CONFIGURED_CHANNEL",
		});
		expect(service.isChannelAllowed("C1")).toBe(true);
	});

	it("stops listening in a channel the agent joined", async () => {
		const service = serviceWithChannel(["C9"]);
		service.addAllowedChannel("C1");
		expect(service.isChannelAllowed("C1")).toBe(true);
		await leave(service);
		expect(service.isChannelAllowed("C1")).toBe(false);
	});
});
