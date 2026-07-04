/**
 * Inbound mute gate in the messageCreate listener: a channel whose room (or
 * world/guild, or thread parent) carries the persisted mute state is dropped
 * BEFORE ingestion — no debouncer enqueue, no messageManager dispatch — even
 * for direct @mentions. Fake discord.js client + map-backed runtime; the
 * room/world stores are the same ones the ROOM action writes, so this locks
 * the runtime-mutable, restart-surviving replacement for boot-frozen
 * CHANNEL_IDS gating.
 */
import { EventEmitter } from "node:events";
import { createUniqueUuid, type UUID } from "@elizaos/core";
import { ChannelType as DiscordChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const debouncerState = vi.hoisted(() => {
	const channelEnqueue = vi.fn();
	return {
		channelEnqueue,
		createChannelDebouncer: vi.fn(() => ({
			destroy: vi.fn(),
			enqueue: channelEnqueue,
			flushAll: vi.fn(),
			markResponded: vi.fn(),
			pendingCount: vi.fn(() => 0),
		})),
	};
});

vi.mock("../debouncer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../debouncer")>();
	return {
		...actual,
		createChannelDebouncer: debouncerState.createChannelDebouncer,
	};
});

import { setupDiscordEventListeners } from "../discord-events";

const BOT_ID = "123";
const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const GUILD_ID = "guild-1";

function makeService() {
	const states = new Map<string, "FOLLOWED" | "MUTED" | null>();
	const rooms = new Map<string, Record<string, unknown>>();
	const worlds = new Map<string, Record<string, unknown>>();
	const client = new EventEmitter() as EventEmitter & {
		user?: { id: string };
	};
	client.user = { id: BOT_ID };
	const runtime = {
		agentId: AGENT_ID,
		emitEvent: vi.fn(),
		getSetting: vi.fn(() => undefined),
		logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		reportError: vi.fn(),
		getParticipantUserState: async (roomId: UUID, entityId: UUID) =>
			states.get(`${roomId}:${entityId}`) ?? null,
		updateParticipantUserState: async (
			roomId: UUID,
			entityId: UUID,
			state: "FOLLOWED" | "MUTED" | null,
		) => {
			states.set(`${roomId}:${entityId}`, state);
		},
		getRoom: async (roomId: UUID) => rooms.get(roomId) ?? null,
		updateRoom: async (room: { id: string }) => {
			rooms.set(room.id, room);
		},
		getWorld: async (worldId: UUID) => worlds.get(worldId) ?? null,
		updateWorld: async (world: { id: string }) => {
			worlds.set(world.id, world);
		},
	};
	const service = {
		accountId: "test",
		allowAllSlashCommands: new Set(),
		allowedChannelIds: undefined,
		buildMemoryFromMessage: vi.fn(),
		character: {},
		client,
		channelDebouncer: undefined as unknown,
		discordSettings: {
			shouldIgnoreBotMessages: true,
			shouldRespondOnlyToMentions: true,
		},
		getChannelType: vi.fn(),
		handleGuildCreate: vi.fn(),
		handleGuildMemberAdd: vi.fn(),
		handleInteractionCreate: vi.fn(),
		handleReactionAdd: vi.fn(),
		handleReactionRemove: vi.fn(),
		isChannelAllowed: vi.fn(() => true),
		messageManager: { handleMessage: vi.fn() },
		resolveDiscordEntityId: vi.fn(),
		runtime,
		slashCommands: [],
		timeouts: [],
		userSelections: new Map(),
		voiceManager: undefined,
	};
	return { service, runtime, states, rooms, worlds };
}

function makeChannelMessage(channelId: string, parentId?: string) {
	return {
		id: `msg-${channelId}`,
		// A direct @mention of the bot: the gate must drop it anyway.
		content: `<@${BOT_ID}> hello`,
		author: { id: "user-1", bot: false, username: "alice" },
		guildId: GUILD_ID,
		channel: {
			id: channelId,
			type: DiscordChannelType.GuildText,
			...(parentId ? { parentId } : {}),
		},
	};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function wire(service: ReturnType<typeof makeService>["service"]) {
	const { channelDebouncer } = setupDiscordEventListeners(service as never);
	service.channelDebouncer = channelDebouncer as never;
}

describe("messageCreate — persisted mute gate before ingestion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("drops a direct @mention in a room-muted channel before the debouncer", async () => {
		const { service, runtime, states } = makeService();
		const roomId = createUniqueUuid(runtime as never, "chan-1");
		states.set(`${roomId}:${AGENT_ID}`, "MUTED");
		wire(service);

		service.client.emit("messageCreate", makeChannelMessage("chan-1"));
		await tick();

		expect(debouncerState.channelEnqueue).not.toHaveBeenCalled();
		expect(service.messageManager.handleMessage).not.toHaveBeenCalled();
	});

	it("passes an unmuted channel through to the debouncer", async () => {
		const { service } = makeService();
		wire(service);

		service.client.emit("messageCreate", makeChannelMessage("chan-2"));
		await tick();

		expect(debouncerState.channelEnqueue).toHaveBeenCalledTimes(1);
	});

	it("a guild-wide world mute drops a child channel with no room-level mute", async () => {
		const { service, runtime, worlds } = makeService();
		const worldId = createUniqueUuid(runtime as never, GUILD_ID);
		worlds.set(worldId, {
			id: worldId,
			metadata: { agentMuteState: "MUTED" },
		});
		wire(service);

		service.client.emit("messageCreate", makeChannelMessage("chan-3"));
		await tick();

		expect(debouncerState.channelEnqueue).not.toHaveBeenCalled();
	});

	it("a muted parent channel silences its thread", async () => {
		const { service, runtime, states } = makeService();
		const parentRoomId = createUniqueUuid(runtime as never, "parent-1");
		states.set(`${parentRoomId}:${AGENT_ID}`, "MUTED");
		wire(service);

		service.client.emit(
			"messageCreate",
			makeChannelMessage("thread-1", "parent-1"),
		);
		await tick();

		expect(debouncerState.channelEnqueue).not.toHaveBeenCalled();
	});

	it("auto-unmutes an expired timed mute and processes the message", async () => {
		const { service, runtime, states, rooms } = makeService();
		const roomId = createUniqueUuid(runtime as never, "chan-4");
		states.set(`${roomId}:${AGENT_ID}`, "MUTED");
		rooms.set(roomId, {
			id: roomId,
			metadata: {
				agentMuteUntilIso: new Date(Date.now() - 1_000).toISOString(),
			},
		});
		wire(service);

		service.client.emit("messageCreate", makeChannelMessage("chan-4"));
		await tick();

		expect(states.get(`${roomId}:${AGENT_ID}`)).toBeNull();
		expect(debouncerState.channelEnqueue).toHaveBeenCalledTimes(1);
	});

	it("fails open (and reports) when the mute lookup throws", async () => {
		const { service, runtime } = makeService();
		(runtime as { getParticipantUserState: unknown }).getParticipantUserState =
			async () => {
				throw new Error("db down");
			};
		wire(service);

		service.client.emit("messageCreate", makeChannelMessage("chan-5"));
		await tick();

		expect(runtime.reportError).toHaveBeenCalledTimes(1);
		expect(debouncerState.channelEnqueue).toHaveBeenCalledTimes(1);
	});
});
