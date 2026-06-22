/**
 * Keyless Discord connector loop e2e (#8801, gap 5 — per-plugin harness adoption).
 *
 * This is the Discord plugin's OWN copy of the connector-loop e2e, living in the
 * plugin's test dir and driven by `withMockLlmRuntime()` from
 * `@elizaos/test-harness`. A synthetic inbound `discord.js` `Message` goes
 * through the REAL `MessageManager.handleMessage` (the same entrypoint the
 * gateway `MessageCreate` listener calls): real inbound guards, envelope
 * formatting, `ensureConnection`, then the REAL
 * `DiscordService.prototype.buildMemoryFromMessage` (constructed via
 * `Object.create(DiscordService.prototype)`, so the inbound→Memory mapping is
 * the product's own), the forced-reply turn through the deterministic mock LLM,
 * and delivery via the connector's REAL outbound seam (`channel.send`).
 *
 * The ONLY mocks are the external `discord.js` SDK objects (Client, Channel,
 * Message). No bot token, no discord.com, no network, NO API keys.
 */

import { type MockLlmRuntime, withMockLlmRuntime } from "@elizaos/test-harness";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageManager } from "../messages.ts";
import { DiscordService } from "../service.ts";
import type { DiscordSettings, IDiscordService } from "../types.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
	cleanups.push(harness.cleanup);
	return harness;
}

interface SentMessage {
	channelId: string;
	content: string;
}

let savedPassiveConnectors: string | undefined;

beforeEach(() => {
	// The auto-reply gate ORs `!autoReply` with `lifeOpsPassiveConnectorsEnabled`,
	// which defaults to TRUE when unset (passive ingest, no reply). Pin it off so
	// an explicitly-invoked turn actually generates and delivers a reply.
	savedPassiveConnectors = process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
	process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = "false";
});

afterEach(() => {
	if (savedPassiveConnectors === undefined) {
		delete process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
	} else {
		process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = savedPassiveConnectors;
	}
});

describe("discord connector loop (keyless harness)", () => {
	it("drives a synthetic Discord message through the mock LLM to a delivered reply", async () => {
		// Heuristic (non-strict) proxy: the reply turn makes several model calls;
		// let the proxy answer them deterministically without hand fixtures.
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;

		const sent: SentMessage[] = [];

		const captureClient = {
			user: null,
			users: {
				fetch: async () => {
					throw new Error(
						"client.users.fetch should not be called for a guild channel reply",
					);
				},
			},
		};

		const channelId = "1253563208833433701";
		const guildId = "1253563208833400000";
		const botMemberId = "9999999999999999999";
		const botMember = { id: botMemberId };
		const guild = {
			id: guildId,
			name: "Eliza Test Guild",
			ownerId: "1111111111111111111",
			members: { cache: new Map([[botMemberId, botMember]]) },
			fetch: async () => guild,
		};

		// The outbound seam: `sendMessageInChunks` calls `channel.send(options)`;
		// capturing it is the same surface that, in production, POSTs to Discord's
		// REST `/channels/:id/messages` endpoint.
		const channel = {
			id: channelId,
			type: DiscordChannelType.GuildText,
			name: "general",
			guild,
			client: { user: { id: botMemberId } },
			isThread: () => false,
			permissionsFor: () => ({ has: () => true }),
			send: async (
				options: string | { content?: string },
			): Promise<unknown> => {
				const content =
					typeof options === "string" ? options : (options.content ?? "");
				const id = `${Date.now()}${sent.length}`;
				sent.push({ channelId, content });
				return {
					id,
					content,
					url: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
					createdTimestamp: Date.now(),
					attachments: { size: 0 },
				};
			},
		};

		const authorId = "555000111222333444";
		const author = {
			id: authorId,
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
			displayAvatarURL: () => "https://cdn.discordapp.com/avatar.png",
			send: async () => ({ id: "dm" }),
		};

		const messageId = "1253563208833433999";
		const message = {
			id: messageId,
			content: "Hello agent, please reply.",
			createdTimestamp: Date.now(),
			author,
			member: { displayName: "Tester", nickname: undefined },
			channel,
			guild,
			url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
			interaction: null,
			reference: undefined,
			embeds: [],
			stickers: { size: 0 },
			attachments: { size: 0 },
			mentions: { users: new Map(), repliedUser: undefined },
			react: async () => undefined,
			reactions: { resolve: () => null },
		} as never;

		const discordSettings: DiscordSettings = {
			autoReply: true,
			shouldRespondOnlyToMentions: false,
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: true,
			dmPolicy: "open",
			replyToMode: "first",
		};

		// REAL DiscordService prototype methods (buildMemoryFromMessage,
		// getChannelType, resolveDiscordEntityId, getAccountState,
		// createAccountServiceFacade). An empty account pool means getAccountState()
		// returns null, so the facade resolves everything from these parent fields.
		const discordService = Object.assign(
			Object.create(DiscordService.prototype),
			{
				runtime,
				client: captureClient,
				accountId: "default",
				defaultAccountId: "default",
				discordSettings,
				ownerDiscordUserIds: new Set<string>(),
				accountPool: { get: () => null, getDefault: () => null },
			},
		);

		// MessageManager copies `discordService.getChannelType` by reference
		// (unbound). Bind the REAL method so both the manager's call site and the
		// facade run it with correct `this`.
		discordService.getChannelType =
			DiscordService.prototype.getChannelType.bind(discordService);

		const manager = new MessageManager(
			discordService as unknown as IDiscordService,
			runtime as never,
		);

		// The same entrypoint the gateway MessageCreate listener calls.
		await manager.handleMessage(message);

		expect(
			sent.length,
			"the connector delivered at least one outbound reply",
		).toBeGreaterThan(0);
		expect(
			sent[0]?.content.trim().length,
			"the delivered reply carries text",
		).toBeGreaterThan(0);
		expect(
			sent[0]?.channelId,
			"the reply went back to the inbound channel",
		).toBe(channelId);
	}, 120_000);
});
