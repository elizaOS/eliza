/**
 * Outbound counterpart of the #18419 inbound DM exemption: with CHANNEL_IDS
 * configured (`allowedChannelIds` set on the account state), the send-path
 * guild allowlist gate in `handleSendMessage` must not block DM / group-DM
 * targets — a DM channel id is by definition never in CHANNEL_IDS, so an
 * allowlisted deployment could receive DMs but never send them (including
 * scheduled/proactive owner DMs). Guild channels outside the allowlist stay
 * blocked.
 */
import type { AgentRuntime, UUID } from "@elizaos/core";
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

const DISCORD_USER_ID = "222222222222222222";
const DM_CHANNEL_ID = "333333333333333333";
const GUILD_CHANNEL_ID = "444444444444444444";
const ALLOWED_GUILD_CHANNEL_ID = "555555555555555000";

function makeDmChannel() {
	return {
		id: DM_CHANNEL_ID,
		type: DiscordChannelType.DM,
		isTextBased: () => true,
		isVoiceBased: () => false,
		isThread: () => false,
		send: vi.fn(async (payload: { content?: string }) => ({
			id: "999999999999999999",
			content: payload.content ?? "",
			url: `https://discord.test/dm/999999999999999999`,
			createdTimestamp: Date.now(),
			attachments: new Collection(),
		})),
	};
}

function makeGuildChannel() {
	return {
		id: GUILD_CHANNEL_ID,
		type: DiscordChannelType.GuildText,
		isTextBased: () => true,
		isVoiceBased: () => false,
		isThread: () => false,
		send: vi.fn(async () => {
			throw new Error("guild send must not be reached when disallowed");
		}),
	};
}

describe("handleSendMessage — DM exemption from the guild-channel allowlist", () => {
	let runtime: AgentRuntime;
	let cleanup: () => Promise<void>;

	beforeAll(async () => {
		({ runtime, cleanup } = await createTestRuntime({
			characterName: "DiscordOutboundDmAllowlist",
		}));
	});

	afterAll(async () => {
		await cleanup();
	});

	function makeService(opts: {
		dmChannel: ReturnType<typeof makeDmChannel>;
		guildChannel: ReturnType<typeof makeGuildChannel>;
	}) {
		const user = {
			id: DISCORD_USER_ID,
			username: "recipient",
			displayName: "Recipient",
			dmChannel: opts.dmChannel,
			createDM: vi.fn(async () => opts.dmChannel),
		};
		const client = {
			isReady: () => true,
			user: { id: "111000000000000000", username: "eliza" },
			channels: {
				fetch: vi.fn(async (id: string) =>
					id === GUILD_CHANNEL_ID ? opts.guildChannel : null,
				),
			},
			users: {
				fetch: vi.fn(async (id: string) =>
					id === DISCORD_USER_ID ? user : null,
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
			// The gate under test: a configured guild allowlist that contains
			// neither the DM channel (it never can) nor the guild channel.
			allowedChannelIds: [ALLOWED_GUILD_CHANNEL_ID],
			dynamicChannelIds: new Set(),
			clientReadyPromise: Promise.resolve(),
			loginFailed: false,
		});
		const service = new DiscordService(runtime) as MutableDiscordService;
		service.accountPool = accountPool;
		service.defaultAccountId = "default";
		service.resolveDiscordTargetUserId = vi.fn(async () => DISCORD_USER_ID);
		return service;
	}

	it("delivers an entity-targeted DM despite a configured CHANNEL_IDS allowlist", async () => {
		const dmChannel = makeDmChannel();
		const guildChannel = makeGuildChannel();
		const service = makeService({ dmChannel, guildChannel });

		const result = await service.handleSendMessage(
			runtime,
			{
				source: "discord",
				accountId: "default",
				entityId: DISCORD_USER_ID as UUID,
			},
			{ text: "scheduled morning brief", agentVoiced: true },
		);

		expect(dmChannel.send).toHaveBeenCalledTimes(1);
		expect(result).not.toMatchObject({
			kind: "not_delivered",
			code: "DISCORD_CHANNEL_NOT_ALLOWED",
		});
	});

	it("still blocks a guild channel outside the allowlist", async () => {
		const dmChannel = makeDmChannel();
		const guildChannel = makeGuildChannel();
		const service = makeService({ dmChannel, guildChannel });

		const result = await service.handleSendMessage(
			runtime,
			{
				source: "discord",
				accountId: "default",
				channelId: GUILD_CHANNEL_ID,
			},
			{ text: "should not go out" },
		);

		expect(guildChannel.send).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			kind: "not_delivered",
			code: "DISCORD_CHANNEL_NOT_ALLOWED",
		});
	});
});
