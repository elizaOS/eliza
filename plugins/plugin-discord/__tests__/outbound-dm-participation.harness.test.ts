/**
 * Real-PGlite proof that generic MESSAGE dispatch into an entity-targeted
 * Discord DM establishes canonical participation, persists provider evidence,
 * and reports a repeated send as a no-op without fabricating another record.
 */
import {
	type ActionResult,
	type AgentRuntime,
	createUniqueUuid,
	type Memory,
	messageAction,
	type UUID,
} from "@elizaos/core";
import { Collection, ChannelType as DiscordChannelType } from "discord.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	DiscordAccountClientPool,
	type DiscordAccountClientState,
} from "../account-client-pool.ts";
import { DiscordService } from "../service.ts";
import { createTestRuntime } from "../test/helpers/pglite-runtime.ts";

type MutableDiscordService = DiscordService & {
	accountPool: DiscordAccountClientPool;
	defaultAccountId: string;
	resolveDiscordTargetUserId: (entityId: string) => Promise<string | null>;
};

describe("Discord outbound DM participation", () => {
	let runtime: AgentRuntime;
	let cleanup: () => Promise<void>;

	beforeAll(async () => {
		({ runtime, cleanup } = await createTestRuntime({
			characterName: "DiscordOutboundDmParticipation",
		}));
	});

	afterAll(async () => {
		await cleanup();
	});

	it("persists one provider-backed send and truthfully reports a committed duplicate", async () => {
		const recipient = "11111111-1111-1111-1111-111111111111" as UUID;
		const discordUserId = "222222222222222222";
		const dmChannel = {
			id: "333333333333333333",
			type: DiscordChannelType.DM,
			isTextBased: () => true,
			isVoiceBased: () => false,
			isThread: () => false,
			send: vi.fn(async (payload: { content?: string }) => ({
				id: "444444444444444444",
				content: payload.content ?? "",
				url: "https://discord.test/dm/444444444444444444",
				createdTimestamp: Date.now(),
				attachments: new Collection(),
			})),
		};
		const user = {
			id: discordUserId,
			username: "recipient",
			displayName: "Recipient",
			dmChannel,
			createDM: vi.fn(async () => dmChannel),
		};
		const client = {
			isReady: () => true,
			user: {
				id: "555555555555555555",
				username: "eliza",
				displayName: "Eliza",
			},
			channels: { fetch: vi.fn() },
			users: {
				fetch: vi.fn(async (id: string) =>
					id === discordUserId ? user : null,
				),
			},
		};
		const accountPool = new DiscordAccountClientPool("default");
		accountPool.set({
			accountId: "default",
			account: {
				accountId: "default",
				name: "Default",
				token: "test-token",
				tokenSource: "config",
				enabled: true,
				config: {},
			},
			client: client as unknown as NonNullable<
				DiscordAccountClientState["client"]
			>,
			settings: {
				shouldIgnoreBotMessages: true,
				shouldIgnoreDirectMessages: false,
				shouldRespondOnlyToMentions: false,
				dmPolicy: "open",
				allowFrom: [],
				syncProfile: false,
				autoReply: false,
			},
			allowedChannelIds: undefined,
			dynamicChannelIds: new Set(),
			clientReadyPromise: Promise.resolve(),
			loginFailed: false,
		});
		const service = new DiscordService(runtime) as MutableDiscordService;
		service.accountPool = accountPool;
		service.defaultAccountId = "default";
		service.resolveDiscordTargetUserId = vi.fn(async () => discordUserId);
		runtime.registerMessageConnector({
			source: "discord",
			accountId: "default",
			label: "Discord",
			capabilities: [],
			supportedTargetKinds: ["user"],
			contexts: ["messaging"],
			sendHandler: (sendRuntime, target, content) =>
				service.handleSendMessage(sendRuntime, target, content),
		});

		const roomId = createUniqueUuid(runtime, dmChannel.id);
		const inboundMessage = {
			id: "66666666-6666-6666-6666-666666666666" as UUID,
			entityId: recipient,
			agentId: runtime.agentId,
			roomId,
			content: { text: "send the persistence canary", source: "discord" },
			metadata: { type: "message", source: "discord", accountId: "default" },
			createdAt: Date.now(),
		} as Memory;
		const dispatch = async (): Promise<ActionResult> => {
			const result = await messageAction.handler(
				runtime,
				inboundMessage,
				undefined,
				{
					parameters: {
						action: "send",
						source: "discord",
						accountId: "default",
						target: recipient,
						targetKind: "user",
						message: "real persistence canary",
					},
				},
				undefined,
				undefined,
			);
			if (!result) throw new Error("MESSAGE returned no result");
			return result;
		};

		const first = await dispatch();
		expect(first).toMatchObject({
			success: true,
			data: {
				deliveryStatus: "delivered",
				responseMessageId: "444444444444444444",
			},
		});
		expect(first.text).toContain("Message sent via Discord");

		expect(new Set(await runtime.getParticipantsForRoom(roomId))).toEqual(
			new Set([recipient, runtime.agentId]),
		);
		expect(await runtime.getRoomsForParticipant(recipient)).toContain(roomId);
		const storedAfterFirst = await runtime.getMemories({
			roomId,
			tableName: "messages",
			count: 10,
		});
		expect(storedAfterFirst).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					entityId: runtime.agentId,
					content: expect.objectContaining({
						text: "real persistence canary",
					}),
					metadata: expect.objectContaining({
						platformMessageId: "444444444444444444",
					}),
				}),
			]),
		);
		const storedIdsAfterFirst = storedAfterFirst
			.map((memory) => memory.id)
			.sort();

		const second = await dispatch();
		expect(second).toMatchObject({
			success: true,
			data: {
				deliveryStatus: "duplicate",
				priorDelivery: "delivered",
				responseMessageId: "444444444444444444",
				newDelivery: false,
				persisted: false,
			},
		});
		expect(second.text).toContain("had already been delivered");
		expect(second.text).not.toContain("Message sent");
		expect(dmChannel.send).toHaveBeenCalledTimes(1);
		const storedAfterSecond = await runtime.getMemories({
			roomId,
			tableName: "messages",
			count: 10,
		});
		expect(storedAfterSecond.map((memory) => memory.id).sort()).toEqual(
			storedIdsAfterFirst,
		);
	});
});
