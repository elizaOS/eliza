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
import { DiscordService } from "../service";

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

	it("the per-account service facade forwards every membership hook with the state account id (r6)", async () => {
		// RP r6: round-5 finding 2 had no byte-level regression guard. The
		// facade is built by the private createAccountServiceFacade over
		// (parent, state) only — a prototype-only instance is enough to
		// exercise it. If any of the five membership hooks is dropped from
		// the facade, the corresponding forward here receives undefined.
		const calls: Record<string, unknown[][]> = {};
		const hookNames = [
			"publishGuildMembershipEvidence",
			"publishMemberMembershipDelta",
			"publishMemberPermissionDelta",
			"degradeMembershipForAccount",
			"renewSenderMembershipEvidence",
		] as const;
		const parent = {
			accountPool: new Map(),
			...Object.fromEntries(
				hookNames.map((name) => [name, vi.fn().mockResolvedValue(undefined)]),
			),
		};
		const state = { accountId: "acct-secondary", account: { token: "" } };
		const facade = (
			DiscordService.prototype as unknown as {
				createAccountServiceFacade: (
					this: unknown,
					state: unknown,
				) => Record<string, (...args: unknown[]) => unknown>;
			}
		).createAccountServiceFacade.call(parent, state);

		// Snapshot the forwarding identity of each membership hook before
		// invocation so the RED control distinguishes a dropped forward from
		// a forwarding bug.
		for (const name of hookNames) {
			calls[name] = [];
		}
		expect(typeof facade.publishGuildMembershipEvidence).toBe("function");
		expect(typeof facade.publishMemberMembershipDelta).toBe("function");
		expect(typeof facade.publishMemberPermissionDelta).toBe("function");
		expect(typeof facade.degradeMembershipForAccount).toBe("function");
		expect(typeof facade.renewSenderMembershipEvidence).toBe("function");

		const guildArg = { id: "300" } as never;
		await facade.publishGuildMembershipEvidence("acct-secondary", guildArg);
		await facade.publishMemberMembershipDelta({ guildId: "300" } as never);
		await facade.publishMemberPermissionDelta({ guildId: "300" } as never);
		await facade.degradeMembershipForAccount("acct-secondary", "r6", ["300"]);
		await facade.renewSenderMembershipEvidence({ guildId: "300" } as never);

		for (const name of hookNames) {
			const parentHook = (
				parent as unknown as Record<string, { mock: { calls: unknown[][] } }>
			)[name];
			expect(
				parentHook.mock.calls.length,
				`${name} forwarded to parent`,
			).toBeGreaterThanOrEqual(1);
			calls[name].push(...parentHook.mock.calls);
		}
		// Every hook must carry the facade state's account id — either as
		// the explicit first argument (direct hooks) or stamped on the
		// forwarded options object (options-carrying hooks).
		const forwarded = parent as unknown as Record<
			string,
			{ mock: { calls: any[][] } }
		>;
		expect(forwarded.publishGuildMembershipEvidence.mock.calls[0][0]).toBe(
			"acct-secondary",
		);
		expect(forwarded.degradeMembershipForAccount.mock.calls[0][0]).toBe(
			"acct-secondary",
		);
		const deltaCall = forwarded.publishMemberMembershipDelta.mock.calls[0][0];
		expect(deltaCall.accountId).toBe("acct-secondary");
		const permCall = forwarded.publishMemberPermissionDelta.mock.calls[0][0];
		expect(permCall.accountId).toBe("acct-secondary");
		const renewCall = forwarded.renewSenderMembershipEvidence.mock.calls[0][0];
		expect(renewCall.accountId).toBe("acct-secondary");
	});
});
