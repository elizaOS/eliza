/**
 * Membership evidence wiring for permission-relevant gateway events
 * (#24365): channelUpdate overwrite deltas, roleUpdate aggregates, and
 * guildMemberUpdate role transitions must reach the membership publisher
 * under the DEFAULT configuration — outside the DISCORD_AUDIT_LOG_ENABLED
 * gate — and gateway shard degrade must be shard-exact when geometry is
 * known. Harness is mocked at the service boundary (real listener
 * registration + real handler bodies, mocked discord.js shapes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupDiscordEventListeners } from "../discord-events";

type GuildLike = { id: string; shardId?: number };

function makeClient(guilds: GuildLike[], shardCount: number) {
	const listeners = new Map<string, unknown[]>();
	const client = {
		guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
		options: { shardCount },
		on: (event: string, handler: unknown) => {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
			return client;
		},
		emit: (event: string, ...args: unknown[]) => {
			for (const handler of listeners.get(event) ?? []) {
				(handler as (...a: unknown[]) => unknown)(...args);
			}
		},
	};
	return client;
}

function makeService(guilds: GuildLike[], shardCount: number) {
	const degrade = vi.fn().mockResolvedValue(undefined);
	const publishGuild = vi.fn().mockResolvedValue(undefined);
	const publishMemberPermissionDelta = vi.fn().mockResolvedValue(undefined);
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
		publishMemberPermissionDelta,
		resolveDiscordEntityId: vi.fn(),
		runtime: {
			agentId: "agent",
			emitEvent: vi.fn(),
			getSetting: vi.fn(() => undefined),
			reportError: vi.fn(),
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
	return {
		service,
		degrade,
		publishGuild,
		publishMemberPermissionDelta,
		client,
	};
}

function makeCollection<T extends { id: string }>(items: T[]) {
	return {
		get: (id: string) => items.find((item) => item.id === id),
		has: (id: string) => items.some((item) => item.id === id),
		keys: () => items.map((item) => item.id)[Symbol.iterator](),
		values: () => items[Symbol.iterator](),
		forEach: (fn: (item: T) => void) => items.forEach(fn),
		[Symbol.iterator]: () => items.entries(),
		filter: (fn: (item: T) => boolean) => makeCollection(items.filter(fn)),
	};
}

function makeGuild({
	id,
	roles = [],
	members = [],
}: {
	id: string;
	roles?: Array<{ id: string; permissions: { bitfield: bigint } }>;
	members?: Array<{
		id: string;
		roles: { cache: { has(id: string): boolean } };
	}>;
}) {
	return {
		id,
		ownerId: "owner",
		members: { cache: makeCollection(members) },
		roles: {
			cache: makeCollection(roles),
			everyone: { id: "@everyone", permissions: { bitfield: 0n } },
		},
	};
}

function makeMember({ id, roles }: { id: string; roles: string[] }) {
	return {
		id,
		pending: false,
		user: { bot: false, tag: `${id}#0000` },
		roles: {
			cache: makeCollection(
				roles.map((r) => ({ id: r, permissions: { bitfield: 0n }, name: r })),
			),
		},
		permissions: { bitfield: 0n },
	};
}

function makeChannel({
	id,
	guild,
	overwrites,
}: {
	id: string;
	guild: ReturnType<typeof makeGuild>;
	overwrites: Array<{
		id: string;
		type: number;
		allow: { bitfield: bigint; toArray(): string[] };
		deny: { bitfield: bigint; toArray(): string[] };
	}>;
}) {
	return {
		id,
		name: `channel-${id}`,
		guild,
		permissionOverwrites: { cache: makeCollection(overwrites) },
	};
}

describe("membership permission-event wiring (#24365)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("guildMemberUpdate reaches the membership publisher with default settings", async () => {
		const { service, publishMemberPermissionDelta, client } = makeService(
			[{ id: "100", shardId: 0 }],
			1,
		);
		setupDiscordEventListeners(service as never);

		const guild = makeGuild({ id: "100", members: [] });
		const oldMember = {
			...makeMember({ id: "42", roles: ["r1"] }),
			partial: false,
		};
		const newMember = {
			...makeMember({ id: "42", roles: ["r1", "r2"] }),
			partial: false,
			guild,
		};
		client.emit("guildMemberUpdate", oldMember, newMember);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(publishMemberPermissionDelta).toHaveBeenCalledTimes(1);
		const options = publishMemberPermissionDelta.mock.calls[0][0];
		expect(options.accountId).toBe("test");
		expect(options.eventId).toBe("42");
	});

	it("roleUpdate publishes a permission delta for members holding the changed role", async () => {
		const { service, publishMemberPermissionDelta, client } = makeService(
			[{ id: "100", shardId: 0 }],
			1,
		);
		setupDiscordEventListeners(service as never);

		const member = makeMember({ id: "42", roles: ["r1"] });
		const guild = makeGuild({
			id: "100",
			members: [member],
			roles: [{ id: "r1", permissions: { bitfield: 8n } }],
		});
		const oldRole = {
			id: "r1",
			name: "role",
			guild,
			permissions: { bitfield: 8n, toArray: () => ["MANAGE_GUILD"] },
		};
		const newRole = {
			id: "r1",
			name: "role",
			guild,
			permissions: { bitfield: 16n, toArray: () => ["KICK_MEMBERS"] },
		};
		client.emit("roleUpdate", oldRole, newRole);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(publishMemberPermissionDelta).toHaveBeenCalledTimes(1);
		const options = publishMemberPermissionDelta.mock.calls[0][0];
		expect(options.accountId).toBe("test");
		expect(options.oldMember.permissions).toBe(8n);
		expect(options.newMember.permissions).toBe(16n);
	});

	it("channelUpdate publishes overwrite deltas with pre-change overwrites", async () => {
		const { service, publishMemberPermissionDelta, client } = makeService(
			[{ id: "100", shardId: 0 }],
			1,
		);
		setupDiscordEventListeners(service as never);

		const member = makeMember({ id: "42", roles: [] });
		const guild = makeGuild({ id: "100", members: [member] });
		const ow = (id: string, allow: bigint) => ({
			id,
			type: 1,
			allow: {
				bitfield: allow,
				toArray: () => (allow ? ["VIEW_CHANNEL"] : []),
			},
			deny: { bitfield: 0n, toArray: () => [] },
		});
		const oldChannel = makeChannel({
			id: "c1",
			guild,
			overwrites: [ow("42", 1024n)],
		});
		const newChannel = makeChannel({
			id: "c1",
			guild,
			overwrites: [ow("42", 0n)],
		});
		client.emit("channelUpdate", oldChannel, newChannel);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(publishMemberPermissionDelta).toHaveBeenCalledTimes(1);
		const options = publishMemberPermissionDelta.mock.calls[0][0];
		expect(options.accountId).toBe("test");
		expect(options.oldChannelOverwrites.get("c1")[0].allow).toBe(1024n);
	});

	it("shardDisconnect with fully-stamped geometry degrades only the disconnected shard's guilds", async () => {
		const { service, degrade, client } = makeService(
			[
				{ id: "100", shardId: 0 },
				{ id: "200", shardId: 1 },
			],
			2,
		);
		setupDiscordEventListeners(service as never);
		client.emit("shardDisconnect", { code: 1000 }, 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(degrade).toHaveBeenCalledTimes(1);
		expect(degrade.mock.calls[0][2]).toEqual(["100"]);
	});

	it("a known shard with zero cached guilds degrades nothing (no healthy-shard sweep)", async () => {
		const { service, degrade, client } = makeService(
			[
				{ id: "100", shardId: 0 },
				{ id: "200", shardId: 0 },
			],
			2,
		);
		setupDiscordEventListeners(service as never);
		// Shard 1 is real (shardCount 2) but owns no cached guilds; all
		// cached guilds carry shard stamps, so its geometry is known-exact.
		client.emit("shardDisconnect", { code: 1000 }, 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(degrade).toHaveBeenCalledTimes(1);
		// An EMPTY worldIds list must be forwarded — degradeAllForAccount
		// treats [] as "no scopes degrade" and undefined as "degrade all".
		// The old code collapsed both into the all-guilds fallback.
		expect(degrade.mock.calls[0][2]).toEqual([]);
	});
});
