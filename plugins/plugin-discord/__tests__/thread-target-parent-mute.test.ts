/**
 * Muted-display consistency for threads: a thread target listed by
 * listConnectorRooms carries its parent channel id, and the core muted-flag
 * resolver behind list_channels / list_connections reports the thread muted
 * when the PARENT channel's room is muted — the same [room, parent]
 * inheritance the inbound gate enforces when it drops the thread's messages
 * ("a muted parent channel silences its thread" in
 * discord-events-mute-gate.test.ts). Real DiscordService.listConnectorRooms +
 * real core resolver over a fake discord.js guild cache and map-backed runtime.
 */
import {
	createUniqueUuid,
	type IAgentRuntime,
	type MessageConnectorQueryContext,
	resolveMutedTargetFlags,
	type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DiscordService } from "../service.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;

function makeRuntime() {
	const states = new Map<string, "FOLLOWED" | "MUTED" | null>();
	const rooms = new Map<string, Record<string, unknown>>();
	const runtime = {
		agentId: AGENT_ID,
		getParticipantUserState: async (roomId: UUID, entityId: UUID) =>
			states.get(`${roomId}:${entityId}`) ?? null,
		getRoom: async (roomId: UUID) => rooms.get(roomId) ?? null,
		getWorld: async () => null,
	} as unknown as IAgentRuntime;
	return { runtime, states };
}

interface FakeGuild {
	id: string;
	name: string;
	channels: { cache: Map<string, unknown> };
}

function fakeChannel(
	id: string,
	name: string,
	guild: FakeGuild,
	options?: { parentId?: string; thread?: boolean },
) {
	return {
		id,
		name,
		guild,
		parentId: options?.parentId ?? null,
		isTextBased: () => true,
		isVoiceBased: () => false,
		isThread: () => options?.thread === true,
	};
}

function serviceWithGuild(runtime: IAgentRuntime, guild: FakeGuild) {
	const client = {
		guilds: { cache: new Map([[guild.id, guild]]) },
	};
	return Object.assign(Object.create(DiscordService.prototype), {
		runtime,
		client,
		defaultAccountId: "default",
		accountPool: { get: () => null, getDefault: () => null },
	}) as DiscordService;
}

describe("thread targets — parent-channel mute inheritance in listings", () => {
	it("a thread of a muted parent lists as muted, matching the drop path", async () => {
		const { runtime, states } = makeRuntime();
		const guild: FakeGuild = {
			id: "guild-1",
			name: "Guild",
			channels: { cache: new Map() },
		};
		guild.channels.cache.set(
			"parent-1",
			fakeChannel("parent-1", "general", guild),
		);
		guild.channels.cache.set(
			"thread-1",
			fakeChannel("thread-1", "help-thread", guild, {
				parentId: "parent-1",
				thread: true,
			}),
		);
		guild.channels.cache.set(
			"chan-2",
			fakeChannel("chan-2", "random", guild),
		);
		// Same persisted state the ROOM action writes and the inbound gate reads
		// when it drops the thread's messages.
		const parentRoomId = createUniqueUuid(runtime, "parent-1");
		states.set(`${parentRoomId}:${AGENT_ID}`, "MUTED");

		const service = serviceWithGuild(runtime, guild);
		const targets = await service.listConnectorRooms({
			runtime,
		} as MessageConnectorQueryContext);

		const thread = targets.find((t) => t.kind === "thread");
		expect(thread).toBeDefined();
		// The listed thread target names its parent so mute inheritance is
		// resolvable without a live channel lookup downstream.
		expect(thread?.target.parentChannelId).toBe("parent-1");

		const flags = await resolveMutedTargetFlags(runtime, targets);
		const flagByChannelId = new Map(
			targets.map((t, index) => [t.target.channelId, flags[index]]),
		);
		expect(flagByChannelId.get("parent-1")).toBe(true);
		expect(flagByChannelId.get("thread-1")).toBe(true);
		expect(flagByChannelId.get("chan-2")).toBe(false);
	});
});
