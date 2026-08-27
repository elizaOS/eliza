/**
 * Event-wiring coverage for the #24365 membership-evidence gateway
 * lifecycle: shardDisconnect degrades only the disconnected shard's
 * guilds (worldIds), shardResume republishes that shard's guilds, and
 * the account facade forwards every membership hook (a facade missing
 * these optional-method forwards silently disables membership evidence
 * on multi-account clients — RP r5 finding 2). Deterministic harness:
 * the client is an EventEmitter with Map-shaped guild caches, only the
 * Discord guild/channel shapes are synthetic.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupDiscordEventListeners } from "../discord-events";

type GuildLike = { id: string; shardId?: number };

function makeClient(guilds: GuildLike[], shardCount: number) {
	const client = new EventEmitter() as EventEmitter & {
		user?: { id: string };
		guilds: { cache: Map<string, GuildLike> };
		options: { shards: number[]; shardCount: number };
		ws: { shards: { size: number } };
	};
	client.user = { id: "bot-1" };
	client.guilds = { cache: new Map(guilds.map((g) => [g.id, g])) };
	client.options = { shards: [...Array(shardCount).keys()], shardCount };
	client.ws = { shards: { size: shardCount } };
	return client;
}

function makeService(guilds: GuildLike[], shardCount: number) {
	const degrade = vi.fn().mockResolvedValue(undefined);
	const publishGuild = vi.fn().mockResolvedValue(undefined);
	const client = makeClient(guilds, shardCount);
	const service = {
		accountId: "test",
		allowAllSlashCommands: new Set(),
		allowedChannelIds: undefined,
		buildMemoryFromMessage: vi.fn(),
		character: {},
		client,
		discordSettings: {
			shouldIgnoreBotMessages: true,
			shouldRespondOnlyToMentions: false,
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
		runtime: {
			agentId: "agent",
			emitEvent: vi.fn(),
			getSetting: vi.fn(() => undefined),
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn(),
				error: vi.fn(),
			},
		},
		slashCommands: [],
		timeouts: [],
		voiceManager: undefined,
		// #24365 membership surface under test
		degradeMembershipForAccount: degrade,
		publishGuildMembershipEvidence: publishGuild,
	};
	return { service, degrade, publishGuild, client };
}

describe("membership-evidence shard lifecycle wiring (#24365)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shardDisconnect degrades only the disconnected shard's guilds", async () => {
		// Two shards: guild-a stamps shardId 0, guild-b stamps shardId 1.
		const { service, degrade } = makeService(
			[
				{ id: "100", shardId: 0 },
				{ id: "200", shardId: 1 },
			],
			2,
		);
		setupDiscordEventListeners(service as never);
		service.client.emit("shardDisconnect", { code: 1000 }, 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(degrade).toHaveBeenCalledTimes(1);
		const [accountId, reason, worldIds] = degrade.mock.calls[0];
		expect(accountId).toBe("test");
		expect(reason).toContain("gateway_shard_disconnect:0");
		expect(worldIds).toEqual(["100"]);
	});

	it("shardDisconnect with unknown shard geometry conservatively degrades all guilds", async () => {
		// Single-shard client (shardCount 1): formula never matches, so the
		// conservative fallback returns every cached guild.
		const { service, degrade } = makeService(
			[
				{ id: "100", shardId: 0 },
				{ id: "200", shardId: 0 },
			],
			1,
		);
		setupDiscordEventListeners(service as never);
		service.client.emit("shardDisconnect", { code: 1000 }, 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(degrade).toHaveBeenCalledTimes(1);
		const worldIds = degrade.mock.calls[0][2];
		expect([...worldIds].sort()).toEqual(["100", "200"]);
	});

	it("shardResume republishes only the resumed shard's guilds", async () => {
		const { service, publishGuild } = makeService(
			[
				{ id: "100", shardId: 0 },
				{ id: "200", shardId: 1 },
			],
			2,
		);
		setupDiscordEventListeners(service as never);
		service.client.emit("shardResume", 0, 5);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(publishGuild).toHaveBeenCalledTimes(1);
		const [accountId, guild] = publishGuild.mock.calls[0];
		expect(accountId).toBe("test");
		expect(guild.id).toBe("100");
	});

	it("multi-shard formula fallback assigns guilds by snowflake shard math", async () => {
		// Guilds without a shardId stamp fall back to the shard-count
		// formula: (id >> 22) % shardCount. id 1 -> shard 0; 2**22 -> 1 % 2
		// -> shard 1.
		const { service, degrade } = makeService(
			[{ id: "1" }, { id: String(2 ** 22) }],
			2,
		);
		setupDiscordEventListeners(service as never);
		service.client.emit("shardDisconnect", { code: 1000 }, 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(degrade).toHaveBeenCalledTimes(1);
		const worldIds = degrade.mock.calls[0][2];
		expect(worldIds).toEqual([String(2 ** 22)]);
	});
});
