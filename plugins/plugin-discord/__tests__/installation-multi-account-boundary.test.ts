/**
 * Multi-account boundary tests for the installation lifecycle seams
 * (#23107 review round 4): two configured Discord bot accounts sharing one
 * runtime and lifecycle service must produce two independent per-guild
 * installation records — joining the same guild yields two records, and
 * removing one account must not terminalize the other's record or fence the
 * still-connected account's outbound traffic. Deterministic unit harness
 * with production-shaped service facades (real accountId field feeding the
 * same discordInstallationAccountUuid derivation the production seams use)
 * and a real InstallationLifecycleService.
 */

import { EventEmitter } from "node:events";
import { InstallationLifecycleService, stringToUuid } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ICompatRuntime } from "../compat";
import { setupDiscordEventListeners } from "../discord-events";
import {
	discordInstallationAccountUuid,
	discordInstallationAllowsTraffic,
} from "../installation-adapter";
import { MessageManager } from "../messages";
import type { IDiscordService } from "../types";

const BOT_ID = "123";
const agentId = stringToUuid("agent");

type GuildLike = {
	id: string;
	name: string;
	joinedAt: Date | null;
};

function makeGuild(id: string, joinedAtIso: string | null): GuildLike {
	return {
		id,
		name: `Guild ${id}`,
		joinedAt: joinedAtIso ? new Date(joinedAtIso) : null,
	};
}

/**
 * Production-shaped facade: mirrors DiscordServiceInternals with the real
 * accountId field. The production per-account pool facade in service.ts
 * exposes discordInstallationAccountId() derived from its own account state;
 * these harness facades intentionally omit the method to pin the legacy
 * `service.accountId`-derived fallback path, which remains the contract for
 * facades that predate the seam (e.g. test doubles and third-party
 * subclasses).
 */
function makeServiceFacade(runtime: Record<string, unknown>, account: string) {
	const client = new EventEmitter() as EventEmitter & {
		user?: { id: string };
	};
	client.user = { id: BOT_ID };
	const facade = {
		accountId: account,
		allowAllSlashCommands: new Set<string>(),
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
		runtime,
		slashCommands: [],
		timeouts: [] as unknown[],
		voiceManager: undefined,
	};
	return facade;
}

function makeRuntime(service: InstallationLifecycleService | undefined) {
	return {
		agentId,
		emitEvent: vi.fn(),
		getService: vi.fn(() => service),
		getSetting: vi.fn(() => undefined),
		logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
	};
}

function guildPayload(guild: GuildLike) {
	// The listener only reads guild.id/name/joinedAt; give it the shape it
	// touches (avoid pulling full discord.js Guild into this harness).
	return guild as unknown as Parameters<
		Parameters<typeof EventEmitter.prototype.on>[1]
	>[0];
}

const drain = async () => {
	await new Promise((r) => setImmediate(r));
};

describe("multi-account installation lifecycle boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("two production-shaped accounts joining one guild produce two distinct records", async () => {
		const lifecycle = new InstallationLifecycleService();
		const runtime = makeRuntime(lifecycle);
		const alpha = makeServiceFacade(runtime, "alpha");
		const beta = makeServiceFacade(runtime, "beta");
		setupDiscordEventListeners(
			alpha as unknown as Parameters<typeof setupDiscordEventListeners>[0],
		);
		setupDiscordEventListeners(
			beta as unknown as Parameters<typeof setupDiscordEventListeners>[0],
		);

		const guild = makeGuild("shared-guild", "2026-08-26T10:00:00Z");
		alpha.client.emit("guildCreate", guildPayload(guild));
		await drain();
		beta.client.emit("guildCreate", guildPayload(guild));
		await drain();

		const alphaRecord = lifecycle.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: discordInstallationAccountUuid(
				runtime as never,
				"alpha",
			),
			externalWorldId: "shared-guild",
		});
		const betaRecord = lifecycle.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: discordInstallationAccountUuid(
				runtime as never,
				"beta",
			),
			externalWorldId: "shared-guild",
		});
		// Two production-shaped accounts joining one guild must yield two
		// distinct per-account records (not one shared default-account record).
		expect(alphaRecord).not.toBeNull();
		expect(betaRecord).not.toBeNull();
		expect(alphaRecord?.connectorAccountId).not.toBe(
			betaRecord?.connectorAccountId,
		);
		expect(alphaRecord?.state).toBe("permissions_verifying");
		expect(betaRecord?.state).toBe("permissions_verifying");
		// No record may exist under the legacy default-account key: that
		// would mean the accounts collapsed onto the default scope.
		const legacyRecord = lifecycle.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: await import("@elizaos/core").then((m) =>
				m.createUniqueUuid(runtime as never, "discord-default-account"),
			),
			externalWorldId: "shared-guild",
		});
		expect(legacyRecord).toBeNull();
	});

	it("removing one account must not terminalize the other account's record or fence its traffic", async () => {
		const lifecycle = new InstallationLifecycleService();
		const runtime = makeRuntime(lifecycle);
		const alpha = makeServiceFacade(runtime, "alpha");
		const beta = makeServiceFacade(runtime, "beta");
		setupDiscordEventListeners(
			alpha as unknown as Parameters<typeof setupDiscordEventListeners>[0],
		);
		setupDiscordEventListeners(
			beta as unknown as Parameters<typeof setupDiscordEventListeners>[0],
		);

		const guildId = "shared-guild";
		const guild = makeGuild(guildId, "2026-08-26T10:00:00Z");
		alpha.client.emit("guildCreate", guildPayload(guild));
		await drain();
		beta.client.emit("guildCreate", guildPayload(guild));
		await drain();

		// Remove ONLY alpha.
		alpha.client.emit("guildDelete", guildPayload(makeGuild(guildId, null)));
		await drain();

		const alphaRecord = lifecycle.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: discordInstallationAccountUuid(
				runtime as never,
				"alpha",
			),
			externalWorldId: guildId,
		});
		const betaRecord = lifecycle.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: discordInstallationAccountUuid(
				runtime as never,
				"beta",
			),
			externalWorldId: guildId,
		});
		expect(alphaRecord?.state).toBe("removed");
		expect(betaRecord?.state).toBe("permissions_verifying");

		// Outbound traffic gate: beta must still be allowed; alpha must be fenced.
		expect(
			discordInstallationAllowsTraffic(runtime as never, {
				connectorAccountId: discordInstallationAccountUuid(
					runtime as never,
					"beta",
				),
				externalWorldId: guildId,
			}),
		).toBe(true);
		expect(
			discordInstallationAllowsTraffic(runtime as never, {
				connectorAccountId: discordInstallationAccountUuid(
					runtime as never,
					"alpha",
				),
				externalWorldId: guildId,
			}),
		).toBe(false);
	});

	it("the default account keeps the historical discord-default-account record key", async () => {
		const lifecycle = new InstallationLifecycleService();
		const runtime = makeRuntime(lifecycle);
		const facade = makeServiceFacade(runtime, "default");
		setupDiscordEventListeners(
			facade as unknown as Parameters<typeof setupDiscordEventListeners>[0],
		);
		facade.client.emit(
			"guildCreate",
			guildPayload(makeGuild("legacy-guild", "2026-08-26T10:00:00Z")),
		);
		await drain();
		// The pre-fix key must still resolve the record so the removal fence
		// keeps firing for records written before per-account scoping.
		const legacyKey = await import("@elizaos/core").then((m) =>
			m.createUniqueUuid(runtime as never, "discord-default-account"),
		);
		const record = lifecycle.get({
			agentId,
			connectorId: "discord",
			connectorAccountId: legacyKey,
			externalWorldId: "legacy-guild",
		});
		expect(record).not.toBeNull();
	});
});

/**
 * Send-path regression: drive the REAL MessageManager.handleMessage through
 * its outbound fence (messages.ts verifyFencedOutboundSend) for two
 * account-bound managers sharing one runtime and lifecycle service. After
 * alpha's installation is terminalized, alpha's manager must not deliver a
 * reply while beta's manager still does. Guild channel and generation
 * callback are stubbed exactly like the durable-turn harness; the fence and
 * send decision run in real production code.
 */
describe("multi-account outbound fence through the real MessageManager send path", () => {
	const GUILD_ID = "999000000000000000";
	const CHANNEL_ID = "777000000000000000";
	const CLIENT_ID = "888000000000000000";
	const AUTHOR_ID = "555000111222333444";
	const REPLY_TEXT = "one durable reply";

	function makeSendHarness() {
		const lifecycle = new InstallationLifecycleService();
		const sends: { account: string; content?: string }[] = [];
		const memories = new Map<string, unknown>();
		const runtime = {
			agentId,
			character: { name: "Eliza" },
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
			getSetting: (key: string) =>
				key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS" ? "false" : undefined,
			getService: () => lifecycle,
			reportError: vi.fn(),
			emitEvent: vi.fn(),
			ensureConnection: vi.fn(async () => undefined),
			getMemoryById: vi.fn(async (id: string) => memories.get(id) ?? null),
			createMemory: vi.fn(
				async (memory: { id?: string; roomId?: unknown }) =>
					memory.id ?? "mem-1",
			),
			getMemories: vi.fn(async () => []),
			messageService: {
				handleMessage: async (
					_runtime: unknown,
					_message: unknown,
					callback: (content: { text: string }) => Promise<unknown>,
				) => {
					await callback({ text: REPLY_TEXT });
				},
			},
		};
		return { lifecycle, sends, runtime };
	}

	function makeManager(
		harness: ReturnType<typeof makeSendHarness>,
		account: string,
	): MessageManager {
		const service = {
			client: { user: { id: CLIENT_ID } },
			accountId: account,
			getChannelType: async () => "GROUP",
			discordSettings: {
				autoReply: true,
				dmPolicy: "open",
				shouldIgnoreBotMessages: true,
				shouldIgnoreDirectMessages: false,
				replyToMode: "off",
			},
			buildMemoryFromMessage: vi.fn(async (message: { id: string }) => ({
				id: `mem-${message.id}`,
				entityId: stringToUuid(`${account}-${message.id}`),
				agentId,
				roomId: stringToUuid(CHANNEL_ID),
				content: { text: "hello", source: "discord" },
			})),
		} as unknown as IDiscordService;
		return new MessageManager(
			service,
			harness.runtime as unknown as ICompatRuntime,
		);
	}

	function guildInbound(
		harness: ReturnType<typeof makeSendHarness>,
		account: string,
		messageId: string,
	) {
		// Full guild-channel shape so the real canSendMessage gate passes:
		// bot member cached in the guild with ViewChannel|SendMessages|
		// ReadMessageHistory permissions. The channel's own send() is the
		// REAL delivery seam the production path writes to.
		const botMember = {
			permissionsIn: () => null,
			id: CLIENT_ID,
		};
		const channel = {
			id: CHANNEL_ID,
			type: 0,
			isTextBased: () => true,
			isThread: () => false,
			send: async (options: { content?: string }) => {
				harness.sends.push({ account, content: options.content });
				return {
					id: `99000000000000000${harness.sends.length + 1}`,
					content: options.content ?? "",
					createdTimestamp: Date.now(),
					attachments: { size: 0 },
				};
			},
			sendTyping: async () => {},
			guild: {
				id: GUILD_ID,
				name: "Shared Guild",
				ownerId: "444000000000000000",
				members: { cache: new Map([[CLIENT_ID, botMember]]) },
			},
			client: { user: { id: CLIENT_ID } },
			permissionsFor: (member: unknown) => ({
				has: () => true,
				_member: member,
			}),
		};
		return {
			id: messageId,
			content: "hello",
			createdTimestamp: Date.now(),
			author: {
				id: AUTHOR_ID,
				bot: false,
				username: "tester",
				globalName: "Tester",
				displayName: "Tester",
				discriminator: "0",
			},
			member: null,
			channel,
			guild: {
				id: GUILD_ID,
				name: "Shared Guild",
				ownerId: "444000000000000000",
			},
			interaction: null,
			reference: undefined,
			embeds: [],
			stickers: { size: 0 },
			attachments: { size: 0 },
			mentions: { users: new Map(), repliedUser: undefined },
		};
	}

	it("a removed account's manager is fenced from sending while a sibling account's manager still delivers", async () => {
		const harness = makeSendHarness();
		const { lifecycle } = harness;

		// Establish per-account installations for both accounts in the guild:
		// alpha joins then is removed (terminal record), beta stays alive.
		const alphaScope = {
			agentId,
			connectorId: "discord",
			connectorAccountId: discordInstallationAccountUuid(
				harness.runtime as never,
				"alpha",
			),
			externalWorldId: GUILD_ID,
		};
		const betaScope = {
			agentId,
			connectorId: "discord",
			connectorAccountId: discordInstallationAccountUuid(
				harness.runtime as never,
				"beta",
			),
			externalWorldId: GUILD_ID,
		};
		// Drive the real join/remove seams (same production-shaped facades as
		// the record tests above).
		{
			const joinerRuntime = harness.runtime;
			const alphaFacade = makeServiceFacade(joinerRuntime, "alpha");
			const betaFacade = makeServiceFacade(joinerRuntime, "beta");
			setupDiscordEventListeners(
				alphaFacade as unknown as Parameters<
					typeof setupDiscordEventListeners
				>[0],
			);
			setupDiscordEventListeners(
				betaFacade as unknown as Parameters<
					typeof setupDiscordEventListeners
				>[0],
			);
			const guild = makeGuild(GUILD_ID, "2026-08-26T10:00:00Z");
			alphaFacade.client.emit("guildCreate", guildPayload(guild));
			await drain();
			betaFacade.client.emit("guildCreate", guildPayload(guild));
			await drain();
			alphaFacade.client.emit(
				"guildDelete",
				guildPayload(makeGuild(GUILD_ID, null)),
			);
			await drain();
		}
		expect(lifecycle.get(alphaScope)?.state).toBe("removed");
		expect(lifecycle.get(betaScope)?.state).toBe("permissions_verifying");

		// The real send path: alpha's manager must NOT deliver a reply;
		// beta's manager must still deliver one.
		const alphaManager = makeManager(harness, "alpha");
		const betaManager = makeManager(harness, "beta");
		await alphaManager.handleMessage(
			guildInbound(harness, "alpha", "msg-alpha-1") as never,
		);
		await betaManager.handleMessage(
			guildInbound(harness, "beta", "msg-beta-1") as never,
		);

		const delivered = harness.sends.filter((s) => s.content === REPLY_TEXT);
		expect(delivered.map((s) => s.account)).toEqual(["beta"]);
		expect(delivered).toHaveLength(1);
	});
});
