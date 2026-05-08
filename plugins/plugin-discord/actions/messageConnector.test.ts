import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { buildMemoryFromMessage } from "../discord-history";
import { DiscordService } from "../service";

function createRuntime() {
	return {
		agentId: "agent-1",
		registerMessageConnector: vi.fn(),
		registerSendHandler: vi.fn(),
		logger: {
			info: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getRoom: vi.fn(),
		getEntityById: vi.fn(),
		getRelationships: vi.fn().mockResolvedValue([]),
	} as unknown as IAgentRuntime & {
		registerMessageConnector: ReturnType<typeof vi.fn>;
		registerSendHandler: ReturnType<typeof vi.fn>;
	};
}

describe("Discord message connector adapter", () => {
	it("registers connector metadata and dispatches through the existing send handler", async () => {
		const runtime = createRuntime();
		const service = Object.create(
			DiscordService.prototype,
		) as DiscordService & {
			handleSendMessage: ReturnType<typeof vi.fn>;
			resolveConnectorTargets: ReturnType<typeof vi.fn>;
			listRecentConnectorTargets: ReturnType<typeof vi.fn>;
			listConnectorRooms: ReturnType<typeof vi.fn>;
			getConnectorChatContext: ReturnType<typeof vi.fn>;
			getConnectorUserContext: ReturnType<typeof vi.fn>;
		};
		service.handleSendMessage = vi.fn().mockResolvedValue(undefined);
		service.resolveConnectorTargets = vi.fn();
		service.listRecentConnectorTargets = vi.fn();
		service.listConnectorRooms = vi.fn();
		service.getConnectorChatContext = vi.fn();
		service.getConnectorUserContext = vi.fn();

		DiscordService.registerSendHandlers(runtime, service);

		expect(runtime.registerMessageConnector).toHaveBeenCalledOnce();
		const registration = runtime.registerMessageConnector.mock.calls[0][0];
		expect(registration).toMatchObject({
			source: "discord",
			label: "Discord",
			capabilities: expect.arrayContaining([
				"send_message",
				"resolve_targets",
				"chat_context",
				"user_context",
			]),
			supportedTargetKinds: ["channel", "thread", "user"],
			contexts: ["social", "connectors"],
		});

		await registration.sendHandler(
			runtime,
			{ source: "discord", channelId: "123456789012345678" },
			{ text: "hello" },
		);
		expect(service.handleSendMessage).toHaveBeenCalledWith(
			runtime,
			{ source: "discord", channelId: "123456789012345678" },
			{ text: "hello" },
		);
	});

	it("resolves cached channels and users into unified message targets", async () => {
		const runtime = createRuntime();
		const guild: Record<string, unknown> = {
			id: "111111111111111111",
			name: "Milady",
		};
		const channel = {
			id: "222222222222222222",
			name: "general",
			guild,
			isTextBased: () => true,
			isVoiceBased: () => false,
			isThread: () => false,
		};
		const member = {
			id: "333333333333333333",
			displayName: "Ada",
			user: {
				id: "333333333333333333",
				username: "ada",
				globalName: "Ada Lovelace",
				tag: "ada#0001",
				bot: false,
			},
		};
		guild.channels = { cache: new Map([[channel.id, channel]]) };
		guild.members = {
			cache: new Map([[member.id, member]]),
			fetch: vi.fn().mockResolvedValue(new Map([[member.id, member]])),
		};

		const service = Object.create(DiscordService.prototype) as any;
		service.runtime = runtime;
		service.allowedChannelIds = undefined;
		service.dynamicChannelIds = new Set();
		service.client = {
			guilds: { cache: new Map([[guild.id, guild]]) },
			channels: { fetch: vi.fn().mockResolvedValue(channel) },
			users: { fetch: vi.fn().mockResolvedValue(member.user) },
		};

		const channelTargets = await service.resolveConnectorTargets("general", {
			runtime,
		});
		expect(channelTargets[0]).toMatchObject({
			kind: "channel",
			label: "#general",
			target: {
				source: "discord",
				channelId: "222222222222222222",
				serverId: "111111111111111111",
			},
		});

		const userTargets = await service.resolveConnectorTargets("ada", {
			runtime,
		});
		expect(userTargets.some((target: any) => target.kind === "user")).toBe(
			true,
		);
		expect(
			userTargets.find((target: any) => target.kind === "user")?.target
				.entityId,
		).toBe("333333333333333333");
	});

	it("registers account-scoped connectors and routes sends with accountId", async () => {
		const runtime = createRuntime();
		const service = Object.create(DiscordService.prototype) as any;
		service.getAccountIds = vi.fn(() => ["default", "team"]);
		service.getDefaultAccountId = vi.fn(() => "default");
		service.getAccountLabel = vi.fn((accountId: string) =>
			accountId === "team" ? "Team Bot" : "Default Bot",
		);
		service.handleSendMessage = vi.fn().mockResolvedValue(undefined);
		service.resolveConnectorTargets = vi.fn().mockResolvedValue([]);
		service.listRecentConnectorTargets = vi.fn().mockResolvedValue([]);
		service.listConnectorRooms = vi.fn().mockResolvedValue([]);
		service.listConnectorServers = vi.fn().mockResolvedValue([]);
		service.fetchConnectorMessages = vi.fn().mockResolvedValue([]);
		service.searchConnectorMessages = vi.fn().mockResolvedValue([]);
		service.reactConnectorMessage = vi.fn().mockResolvedValue(undefined);
		service.editConnectorMessage = vi.fn();
		service.deleteConnectorMessage = vi.fn().mockResolvedValue(undefined);
		service.pinConnectorMessage = vi.fn().mockResolvedValue(undefined);
		service.joinConnectorChannel = vi.fn();
		service.leaveConnectorChannel = vi.fn().mockResolvedValue(undefined);
		service.getConnectorUser = vi.fn();
		service.getConnectorChatContext = vi.fn();
		service.getConnectorUserContext = vi.fn();

		DiscordService.registerSendHandlers(runtime, service);

		expect(runtime.registerMessageConnector).toHaveBeenCalledTimes(3);
		const registrations = runtime.registerMessageConnector.mock.calls.map(
			(call) => call[0],
		);
		expect(registrations.map((registration) => registration.accountId)).toEqual([
			undefined,
			"default",
			"team",
		]);

		const teamRegistration = registrations.find(
			(registration) => registration.accountId === "team",
		);
		await teamRegistration.sendHandler(
			runtime,
			{ source: "discord", channelId: "222222222222222222" },
			{ text: "team hello" },
		);
		expect(service.handleSendMessage).toHaveBeenCalledWith(
			runtime,
			{
				source: "discord",
				channelId: "222222222222222222",
				accountId: "team",
			},
			{ text: "team hello" },
		);
	});

	it("stamps inbound Discord memories with the accountId", async () => {
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000001",
			logger: {
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		} as any;
		const channel = {
			id: "222222222222222222",
			type: 0,
			guild: { id: "111111111111111111" },
		};
		const message = {
			id: "333333333333333333",
			content: "hello from team",
			createdTimestamp: 1_700_000_000_000,
			url: "https://discord.com/channels/111/222/333",
			author: {
				id: "444444444444444444",
				username: "ada",
				bot: false,
				displayAvatarURL: () => "https://cdn.example/avatar.png",
			},
			channel,
			guild: { id: "111111111111111111" },
			reference: null,
		};
		const memory = await buildMemoryFromMessage(
			{
				accountId: "team",
				runtime,
				messageManager: undefined,
				client: {} as any,
				resolveDiscordEntityId: (userId: string) =>
					`00000000-0000-0000-0000-${userId.slice(-12)}`,
				getChannelType: vi.fn().mockResolvedValue("GROUP"),
				isGuildTextBasedChannel: vi.fn(),
			},
			message as any,
			{ processedContent: "hello from team" },
		);

		expect(memory?.metadata).toMatchObject({
			accountId: "team",
			discord: {
				accountId: "team",
				channelId: "222222222222222222",
				messageId: "333333333333333333",
			},
		});
	});
});
