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
