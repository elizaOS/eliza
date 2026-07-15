/**
 * Covers the Discord service/account-pool primitives that keep retrying login
 * state scoped per account. The tests use real `DiscordService` and
 * `DiscordAccountClientPool` instances with fake discord.js boundary objects so
 * connector registration, account lookup, command registration, and message
 * mutations execute production code without opening a gateway connection.
 */
import { ChannelType as CoreChannelType } from "@elizaos/core";
import { Collection, ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DiscordAccountClientPool,
	type DiscordAccountClientState,
} from "../account-client-pool.ts";
import { DiscordService } from "../service.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

type MutableDiscordService = DiscordService & {
	accountPool: DiscordAccountClientPool;
	defaultAccountId: string;
	allowedChannelIds?: string[];
	dynamicChannelIds: Set<string>;
	ownerDiscordUserIds: Set<string>;
	registerVoiceTarget: (target: unknown) => void;
	unregisterVoiceTarget: (
		accountId: string,
		guildId: string,
		channelId: string,
	) => void;
	resolveDiscordTargetUserId: (
		targetEntityId: string,
	) => Promise<string | null>;
	createAccountServiceFacade: (
		state?: DiscordAccountClientState | null,
	) => Record<string, unknown>;
	buildMemoryFromMessage: ReturnType<typeof vi.fn>;
};

function makeRuntime() {
	const rooms = new Map<string, unknown>();
	const worlds = new Map<string, unknown>();
	return {
		agentId: AGENT_ID,
		character: { name: "Eliza", settings: {} },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getSetting: vi.fn(() => undefined),
		registerMessageConnector: vi.fn(),
		registerSendHandler: vi.fn(),
		ensureConnection: vi.fn().mockResolvedValue(undefined),
		ensureRoomExists: vi.fn(async (room) => {
			rooms.set(String(room.id), room);
		}),
		createRoom: vi.fn(async (room) => {
			rooms.set(String(room.id), room);
			return room.id;
		}),
		getRoom: vi.fn(async (roomId) => rooms.get(String(roomId)) ?? null),
		getWorld: vi.fn(async (worldId) => worlds.get(String(worldId)) ?? null),
		getEntityById: vi.fn(async () => null),
		getRelationships: vi.fn(async () => []),
		emitEvent: vi.fn(),
		reportError: vi.fn(),
	};
}

function makeMessage(overrides: Record<string, unknown> = {}) {
	const message = {
		id: "333333333333333333",
		content: "hello from discord",
		url: "https://discord.test/messages/333333333333333333",
		createdTimestamp: 1_700_000_000_000,
		author: {
			id: "222222222222222222",
			username: "sender",
			globalName: "Sender",
			tag: "sender#0001",
		},
		member: { displayName: "Sender Display" },
		attachments: new Collection(),
		reactions: {
			cache: new Collection([
				[
					"thumbs",
					{
						emoji: {
							name: "👍",
							toString: () => "👍",
						},
						users: { remove: vi.fn().mockResolvedValue(undefined) },
					},
				],
			]),
		},
		react: vi.fn().mockResolvedValue(undefined),
		edit: vi.fn(async (text: string) => ({ ...message, content: text })),
		delete: vi.fn().mockResolvedValue(undefined),
		pin: vi.fn().mockResolvedValue(undefined),
		unpin: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
	return message;
}

function makeDiscordGraph() {
	const message = makeMessage();
	const messages = new Collection<string, unknown>([[message.id, message]]);
	const textChannel = {
		id: "111111111111111111",
		name: "general",
		type: DiscordChannelType.GuildText,
		topic: "General discussion",
		url: "https://discord.test/channels/guild/general",
		guild: null as unknown,
		parentId: null,
		isTextBased: () => true,
		isVoiceBased: () => false,
		isThread: () => false,
		send: vi.fn(async (payload) =>
			makeMessage({
				id: "444444444444444444",
				content: typeof payload === "string" ? payload : payload.content,
				author: { id: "999999999999999999", username: "bot" },
			}),
		),
		sendTyping: vi.fn().mockResolvedValue(undefined),
		messages: {
			// The chat-context hook reads the gateway-populated cache (never a
			// REST fetch — see getConnectorChatContext); fetch remains for the
			// message operations that do address single messages by id.
			cache: new Collection(messages),
			fetch: vi.fn(async (arg?: string | { limit?: number }) => {
				if (typeof arg === "string") {
					return messages.get(arg);
				}
				return new Collection(messages);
			}),
		},
		threads: {
			create: vi.fn(async () => ({
				id: "555555555555555555",
				parentId: "111111111111111111",
			})),
		},
		fetchWebhooks: vi.fn(async () => new Collection()),
		createWebhook: vi.fn(async () => null),
		permissionsFor: vi.fn(() => ({ has: () => true })),
	};
	const voiceChannel = {
		id: "666666666666666666",
		type: DiscordChannelType.GuildVoice,
		isVoiceBased: () => true,
	};
	const cachedUser = {
		id: "222222222222222222",
		username: "sender",
		globalName: "Sender",
		tag: "sender#0001",
		bot: false,
		createDM: vi.fn(),
	};
	const member = {
		id: cachedUser.id,
		displayName: "Sender Display",
		user: cachedUser,
		roles: { cache: new Collection([["role", { name: "member" }]]) },
		joinedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const botMember = {
		id: "999999999999999999",
		displayName: "Eliza",
		user: { id: "999999999999999999", username: "bot", bot: true },
		roles: { cache: new Collection() },
		joinedAt: null,
	};
	const guild = {
		id: "777777777777777777",
		name: "Guild",
		memberCount: 2,
		channels: {
			cache: new Collection([
				[textChannel.id, textChannel],
				[voiceChannel.id, voiceChannel],
			]),
		},
		members: {
			cache: new Collection([
				[member.id, member],
				[botMember.id, botMember],
			]),
			fetch: vi.fn(async () => new Collection([[member.id, member]])),
		},
		fetch: vi.fn(async () => ({
			commands: {
				fetch: vi.fn(async () => new Collection()),
				create: vi.fn().mockResolvedValue(undefined),
			},
		})),
		commands: {
			fetch: vi.fn(async () => new Collection()),
			create: vi.fn().mockResolvedValue(undefined),
		},
	};
	textChannel.guild = guild;
	const client = {
		isReady: () => true,
		user: {
			id: "999999999999999999",
			username: "bot",
			displayName: "Eliza",
			setActivity: vi.fn().mockResolvedValue(undefined),
			setPresence: vi.fn(),
		},
		application: {
			commands: {
				set: vi.fn().mockResolvedValue(undefined),
			},
		},
		guilds: {
			cache: new Collection([[guild.id, guild]]),
			fetch: vi.fn(async () => new Collection([[guild.id, guild]])),
		},
		channels: {
			cache: new Collection([
				[textChannel.id, textChannel],
				[voiceChannel.id, voiceChannel],
			]),
			fetch: vi.fn(async (channelId: string) => {
				if (channelId === textChannel.id) return textChannel;
				if (channelId === voiceChannel.id) return voiceChannel;
				return null;
			}),
		},
		users: {
			fetch: vi.fn(async (userId: string) =>
				userId === cachedUser.id ? cachedUser : null,
			),
		},
		rest: {
			put: vi.fn().mockResolvedValue(undefined),
		},
		destroy: vi.fn().mockResolvedValue(undefined),
	};
	return { botMember, cachedUser, client, guild, member, message, textChannel };
}

function makeState(
	accountId: string,
	client: unknown,
	overrides: Partial<DiscordAccountClientState> = {},
): DiscordAccountClientState {
	return {
		accountId,
		account: {
			accountId,
			name: accountId === "default" ? "Primary" : "Work",
			token: `${accountId}-token`,
			tokenSource: "config",
			enabled: true,
			config: {},
		},
		client: client as DiscordAccountClientState["client"],
		settings: {
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			shouldRespondOnlyToMentions: false,
			dmPolicy: "open",
			allowFrom: [],
			syncProfile: false,
			autoReply: false,
		},
		allowedChannelIds: ["111111111111111111"],
		dynamicChannelIds: new Set(),
		clientReadyPromise: Promise.resolve(),
		loginFailed: false,
		...overrides,
	};
}

function makeService() {
	const runtime = makeRuntime();
	const graph = makeDiscordGraph();
	const service = new DiscordService(
		runtime as unknown as ConstructorParameters<typeof DiscordService>[0],
	) as MutableDiscordService;
	const defaultState = makeState("default", graph.client);
	const workState = makeState("work", graph.client, {
		allowedChannelIds: undefined,
	});
	service.accountPool.setDefaultAccountId("default");
	service.accountPool.set(defaultState);
	service.accountPool.set(workState);
	service.defaultAccountId = "default";
	service.accountId = "default";
	service.client = graph.client as never;
	service.discordSettings = defaultState.settings;
	service.allowedChannelIds = defaultState.allowedChannelIds;
	service.dynamicChannelIds = defaultState.dynamicChannelIds;
	service.clientReadyPromise = defaultState.clientReadyPromise;
	service.buildMemoryFromMessage = vi.fn(async (message, options) => ({
		id: `00000000-0000-0000-0000-${String(message.id).slice(0, 12)}`,
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		roomId: "00000000-0000-0000-0000-000000000002",
		content: { text: message.content, name: message.author?.username },
		metadata: {
			type: "message",
			accountId: options?.accountId ?? "default",
			sender: { username: message.author?.username },
		},
		createdAt: message.createdTimestamp,
	}));
	return { graph, runtime, service };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DiscordAccountClientPool", () => {
	it("normalizes ids, falls back to the first configured state, and clears state", () => {
		const pool = new DiscordAccountClientPool(" Primary ");
		const first = makeState(" Work ", null);
		const second = makeState("Default", null);

		pool.set(first);
		expect(first.accountId).toBe("work");
		expect(pool.get(" WORK ")).toBe(first);
		expect(pool.getDefault()).toBe(first);

		pool.setDefaultAccountId(" DEFAULT ");
		pool.set(second);
		expect(pool.getDefaultAccountId()).toBe("default");
		expect(pool.get()).toBe(second);
		expect(pool.listAccountIds()).toEqual(["work", "default"]);

		pool.clear();
		expect(pool.getDefault()).toBeNull();
		expect(pool.list()).toEqual([]);
	});
});

describe("DiscordService.getAccountLabel", () => {
	it("prefers the configured account name, then falls back to the service default id", () => {
		const pool = new DiscordAccountClientPool("default");
		pool.set(makeState("default", null));
		const service = Object.assign(Object.create(DiscordService.prototype), {
			accountPool: pool,
			defaultAccountId: "default",
		}) as DiscordService;

		// Named account resolves to its display name ("Primary" from makeState),
		// which is what list_connections and the settings UI show to the owner.
		expect(service.getAccountLabel("default")).toBe("Primary");
		// An unknown id has no state; the label falls back to the service's
		// default account id rather than throwing or returning undefined.
		expect(service.getAccountLabel("nope")).toBe("default");
	});
});

describe("DiscordService account-scoped primitives", () => {
	it("registers account connectors and scopes wrapper calls to the selected account", async () => {
		const { runtime, service } = makeService();
		DiscordService.registerSendHandlers(runtime as never, service);

		expect(runtime.registerMessageConnector).toHaveBeenCalledTimes(3);
		const [, defaultRegistration, workRegistration] =
			runtime.registerMessageConnector.mock.calls.map((call) => call[0]);
		expect(defaultRegistration.accountId).toBe("default");
		expect(workRegistration.accountId).toBe("work");

		const sendSpy = vi
			.spyOn(service, "handleSendMessage")
			.mockResolvedValue(undefined);
		await workRegistration.sendHandler(
			runtime,
			{ source: "discord", channelId: "111111111111111111" },
			{ text: "scoped" },
		);
		expect(sendSpy).toHaveBeenCalledWith(
			runtime,
			expect.objectContaining({ accountId: "work" }),
			expect.objectContaining({ text: "scoped" }),
		);
	});

	it("runs slash registration, account lookup, activity, voice status, and channel allowlist logic", async () => {
		const { graph, runtime, service } = makeService();

		expect(service.getDefaultAccountId()).toBe("default");
		expect(service.getAccountIds()).toEqual(["default", "work"]);
		expect(service.getClient("work")).toBe(graph.client);
		expect(service.getAccountLabel("work")).toBe("Work");
		expect(service.isHealthy()).toBe(true);

		await service.registerSlashCommands([
			{
				name: "diagnose",
				description: "Run diagnostics",
				options: [],
				bypassChannelWhitelist: true,
			},
			{
				name: "guild-only",
				description: "Guild command",
				options: [],
				guildOnly: true,
			},
		]);
		expect(graph.client.application.commands.set).toHaveBeenCalled();
		expect(service.allowAllSlashCommands.has("diagnose")).toBe(true);

		expect(await service.setListeningActivity("standby")).toBe(true);
		expect(graph.client.user.setActivity).toHaveBeenCalledWith(
			"standby",
			expect.objectContaining({ type: expect.any(Number) }),
		);
		expect(await service.clearActivity()).toBe(true);
		expect(graph.client.user.setPresence).toHaveBeenCalledWith({
			activities: [],
		});
		expect(
			await service.setVoiceChannelStatus("666666666666666666", " ready "),
		).toBe(true);
		expect(graph.client.rest.put).toHaveBeenCalledWith(
			"/channels/666666666666666666/voice-status",
			{ body: { status: "ready" } },
		);

		expect(service.isChannelAllowed("111111111111111111")).toBe(true);
		expect(service.isChannelAllowed("999999999999999999")).toBe(false);
		expect(service.addAllowedChannel("111111111111111111")).toBe(true);
		expect(service.getAllowedChannels()).toEqual(["111111111111111111"]);
		expect(service.removeAllowedChannel("111111111111111111")).toBe(false);

		service.registerVoiceTarget({
			accountId: " WORK ",
			channel: graph.textChannel,
			guild: graph.guild,
			adapterCreator: {},
		});
		expect(
			service.getVoiceTarget({
				accountId: "work",
				guildId: graph.guild.id,
				channelId: graph.textChannel.id,
			})?.accountId,
		).toBe("work");
		expect(
			service.getVoiceTargets({ guildId: graph.guild.id }).map((target) => ({
				accountId: target.accountId,
				channelId: target.channelId,
			})),
		).toEqual([{ accountId: "work", channelId: "111111111111111111" }]);
		service.unregisterVoiceTarget("work", graph.guild.id, graph.textChannel.id);
		expect(service.getVoiceTargets()).toEqual([]);

		expect(await service.getChannelType(graph.textChannel as never)).toBe(
			CoreChannelType.GROUP,
		);
		expect(runtime.logger.info).toHaveBeenCalled();
	});

	it("resolves connector targets and drives message/channel operations through fake Discord objects", async () => {
		const { graph, runtime, service } = makeService();
		const context = {
			runtime,
			target: {
				source: "discord",
				accountId: "default",
				channelId: graph.textChannel.id,
			},
		};

		const resolved = await service.resolveConnectorTargets("general", context);
		expect(resolved.some((target) => target.kind === "channel")).toBe(true);
		expect(resolved.some((target) => target.kind === "user")).toBe(true);
		expect(await service.listConnectorRooms(context)).toHaveLength(1);
		expect(await service.listRecentConnectorTargets(context)).toHaveLength(1);

		const chatContext = await service.getConnectorChatContext(
			{ source: "discord", channelId: graph.textChannel.id },
			context,
		);
		expect(chatContext?.recentMessages[0]?.text).toBe("hello from discord");

		service.resolveDiscordTargetUserId = vi.fn(async () => graph.cachedUser.id);
		const userContext = await service.getConnectorUserContext(
			graph.cachedUser.id,
			context,
		);
		expect(userContext?.handles.discord).toBe(graph.cachedUser.id);

		const servers = await service.listConnectorServers(context);
		expect(servers[0]).toMatchObject({
			name: "Guild",
			metadata: expect.objectContaining({ accountId: "default" }),
		});

		const fetched = await service.fetchConnectorMessages(context, {
			target: context.target,
			limit: 5,
		});
		expect(fetched[0]?.content.text).toBe("hello from discord");
		const searched = await service.searchConnectorMessages(context, {
			target: context.target,
			query: "hello",
			author: "sender",
		});
		expect(searched).toHaveLength(1);

		await service.reactConnectorMessage(runtime as never, {
			target: context.target,
			messageId: graph.message.id,
			emoji: "👍",
		});
		expect(graph.message.react).toHaveBeenCalledWith("👍");
		await service.reactConnectorMessage(runtime as never, {
			target: context.target,
			messageId: graph.message.id,
			emoji: "👍",
			remove: true,
		});
		expect(
			graph.message.reactions.cache.get("thumbs")?.users.remove,
		).toHaveBeenCalledWith("999999999999999999");

		await expect(
			service.editConnectorMessage(runtime as never, {
				target: context.target,
				messageId: graph.message.id,
				text: "updated",
			}),
		).rejects.toThrow(/own messages/);
		graph.message.author.id = "999999999999999999";
		const edited = await service.editConnectorMessage(runtime as never, {
			target: context.target,
			messageId: graph.message.id,
			text: "updated",
		});
		expect(edited.content.text).toBe("updated");
		await service.deleteConnectorMessage(runtime as never, {
			target: context.target,
			messageId: graph.message.id,
		});
		expect(graph.message.delete).toHaveBeenCalled();
		await service.pinConnectorMessage(runtime as never, {
			target: context.target,
			messageId: graph.message.id,
		});
		expect(graph.message.pin).toHaveBeenCalled();
		await service.pinConnectorMessage(runtime as never, {
			target: context.target,
			messageId: graph.message.id,
			pin: false,
		});
		expect(graph.message.unpin).toHaveBeenCalled();

		await service.sendConnectorTyping(runtime as never, {
			target: context.target,
		});
		expect(graph.textChannel.sendTyping).toHaveBeenCalled();
		const thread = await service.createConnectorThread(runtime as never, {
			target: context.target,
			name: "Diagnostics",
		});
		expect(thread).toEqual({
			threadId: "555555555555555555",
			parentChannelId: graph.textChannel.id,
		});

		const room = await service.joinConnectorChannel(runtime as never, {
			target: context.target,
		});
		expect(room.metadata).toMatchObject({
			accountId: "default",
			discordChannelId: graph.textChannel.id,
		});
		await service.leaveConnectorChannel(runtime as never, {
			target: context.target,
		});

		const connectorUser = await service.getConnectorUser(runtime as never, {
			accountId: "default",
			userId: graph.cachedUser.id,
		});
		expect(connectorUser).toMatchObject({
			metadata: {
				discord: expect.objectContaining({ userId: graph.cachedUser.id }),
			},
		});
		expect(await service.getChannelTopic(graph.textChannel.id)).toBe(
			"General discussion",
		);
		expect(await service.getTextChannelMembers(graph.textChannel.id)).toEqual(
			expect.arrayContaining([
				{
					id: graph.member.id,
					username: graph.member.user.username,
					displayName: graph.member.displayName,
				},
			]),
		);
	});

	it("serves chat-context history from the gateway cache without a REST fetch or room read", async () => {
		const { graph, runtime, service } = makeService();
		const getRoom = vi.fn(async () => ({
			id: "00000000-0000-0000-0000-000000000002",
			channelId: graph.textChannel.id,
		}));
		const context = {
			runtime: { ...runtime, getRoom },
			target: {
				source: "discord",
				accountId: "default",
				channelId: graph.textChannel.id,
			},
		};

		// Target already carries a channelId: no DB room read, no history REST
		// fetch — this hook runs on the Stage-1 critical path every turn.
		const chatContext = await service.getConnectorChatContext(
			{
				source: "discord",
				channelId: graph.textChannel.id,
				roomId: "00000000-0000-0000-0000-000000000002",
			},
			context,
		);
		expect(chatContext?.recentMessages[0]?.text).toBe("hello from discord");
		expect(getRoom).not.toHaveBeenCalled();
		expect(graph.textChannel.messages.fetch).not.toHaveBeenCalled();

		// Without a channelId the room read is the only way to recover one.
		const viaRoom = await service.getConnectorChatContext(
			{ source: "discord", roomId: "00000000-0000-0000-0000-000000000002" },
			context,
		);
		expect(getRoom).toHaveBeenCalledOnce();
		expect(viaRoom?.recentMessages[0]?.text).toBe("hello from discord");
		expect(graph.textChannel.messages.fetch).not.toHaveBeenCalled();
	});

	it("stops account clients, clears retry state, and rejects pending ready waits", async () => {
		const { graph, service } = makeService();
		const state = service.accountPool.get("default");
		expect(state).toBeTruthy();
		const reject = vi.fn();
		if (state) {
			state.loginReadyReject = reject;
			state.loginRetryTimer = setTimeout(() => undefined, 1_000);
			state.voiceManager = { stop: vi.fn() } as never;
			state.channelDebouncer = { destroy: vi.fn() } as never;
		}

		await service.stop();

		expect(reject).toHaveBeenCalledWith(expect.any(Error));
		expect(graph.client.destroy).toHaveBeenCalled();
		expect(service.getAccountIds()).toEqual([]);
		expect(service.client).toBeNull();
	});
});
