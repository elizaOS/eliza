/**
 * listConnectorServers returns the PERSISTED world per guild: durable
 * world.metadata (server-wide agentMuteState, ownership/roles) survives into
 * the list_servers surface instead of being dropped by a fabricated bare
 * World, while live guild fields (name, memberCount) are refreshed on top.
 * Real DiscordService.prototype method + fake guild cache + map-backed
 * runtime — the same world store the ROOM action's server-wide mute writes.
 */
import {
	createUniqueUuid,
	type IAgentRuntime,
	stringToUuid,
	type UUID,
	type World,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DiscordService } from "../service.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const MUTED_GUILD_ID = "guild-muted-1";
const FRESH_GUILD_ID = "guild-fresh-2";

function makeService(worlds: Map<string, World>) {
	const runtime = {
		agentId: AGENT_ID,
		getWorld: async (worldId: UUID) => worlds.get(worldId) ?? null,
	} as unknown as IAgentRuntime;
	const service = Object.create(DiscordService.prototype) as DiscordService & {
		runtime: IAgentRuntime;
		defaultAccountId: string;
		getClient: () => unknown;
	};
	service.runtime = runtime;
	service.defaultAccountId = "default";
	service.getClient = () => ({
		guilds: {
			cache: new Map([
				[
					MUTED_GUILD_ID,
					{ id: MUTED_GUILD_ID, name: "Muted Guild", memberCount: 7 },
				],
				[
					FRESH_GUILD_ID,
					{ id: FRESH_GUILD_ID, name: "Fresh Guild", memberCount: 3 },
				],
			]),
		},
	});
	return { service, runtime };
}

describe("DiscordService.listConnectorServers — persisted world metadata", () => {
	it("carries persisted metadata (server-wide mute) and refreshes live guild fields", async () => {
		const probe = { agentId: AGENT_ID } as IAgentRuntime;
		const mutedWorldId = createUniqueUuid(probe, MUTED_GUILD_ID);
		const worlds = new Map<string, World>([
			[
				mutedWorldId,
				{
					id: mutedWorldId,
					agentId: AGENT_ID,
					name: "Stale Name",
					metadata: {
						agentMuteState: "MUTED",
						ownership: { ownerId: "owner-9" },
					},
				},
			],
		]);
		const { service } = makeService(worlds);

		const servers = await service.listConnectorServers({
			runtime: service.runtime,
		});

		expect(servers).toHaveLength(2);
		const muted = servers.find((s) => s.id === mutedWorldId);
		expect(muted?.metadata?.agentMuteState).toBe("MUTED");
		expect(muted?.metadata?.ownership).toEqual({ ownerId: "owner-9" });
		// Live guild fields still win over the stale persisted snapshot.
		expect(muted?.name).toBe("Muted Guild");
		expect(muted?.metadata?.discordGuildId).toBe(MUTED_GUILD_ID);
		expect(muted?.metadata?.memberCount).toBe(7);
		expect(muted?.messageServerId).toBe(stringToUuid(MUTED_GUILD_ID));
	});

	it("still lists a guild with no persisted world", async () => {
		const { service } = makeService(new Map());
		const servers = await service.listConnectorServers({
			runtime: service.runtime,
		});
		expect(servers).toHaveLength(2);
		const probe = { agentId: AGENT_ID } as IAgentRuntime;
		const fresh = servers.find(
			(s) => s.id === createUniqueUuid(probe, FRESH_GUILD_ID),
		);
		expect(fresh?.name).toBe("Fresh Guild");
		expect(fresh?.metadata?.agentMuteState).toBeUndefined();
	});
});
