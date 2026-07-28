/**
 * Real-PGlite proof that entity-targeted Discord DMs establish canonical
 * recipient participation before sending and persist into that discoverable room.
 */
import { createUniqueUuid, type AgentRuntime, type UUID } from "@elizaos/core";
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

	it("stores the sent message in a room discoverable by the exact recipient", async () => {
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

		const sent = await service.handleSendMessage(
			runtime,
			{ source: "discord", accountId: "default", entityId: recipient },
			{ text: "real persistence canary" },
		);

		const roomId = createUniqueUuid(runtime, dmChannel.id);
		expect(sent?.roomId).toBe(roomId);
		expect(new Set(await runtime.getParticipantsForRoom(roomId))).toEqual(
			new Set([recipient, runtime.agentId]),
		);
		expect(await runtime.getRoomsForParticipant(recipient)).toContain(roomId);
		const stored = await runtime.getMemories({
			roomId,
			tableName: "messages",
			count: 10,
		});
		expect(stored).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: sent?.id,
					entityId: runtime.agentId,
					content: expect.objectContaining({
						text: "real persistence canary",
					}),
				}),
			]),
		);
	});
});
