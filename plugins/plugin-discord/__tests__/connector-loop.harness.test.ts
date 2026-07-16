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
 *
 * Includes the shared-outbound-sanitization round-trip (#15888): a stage-1
 * reply that drifts into native tool-call syntax must reach the Discord wire
 * seam already sanitized by `@elizaos/core` — the plugin's local pre-send
 * sanitizer is gone, so this proves the shared boundary covers Discord.
 */

import { ModelType } from "@elizaos/core";
import {
	type LlmProxyFixture,
	type MockLlmRuntime,
	withMockLlmRuntime,
} from "@elizaos/test-harness";
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

/**
 * Drive one inbound message through the REAL Discord MessageManager and
 * capture everything the connector pushes through its outbound seam — the
 * guild-text `channel.send` or, for `channelKind: "dm"`, the
 * `client.users.fetch(...).send` direct-message seam.
 */
async function driveDiscordTurn(options: {
	inboundText: string;
	fixtures?: LlmProxyFixture[];
	channelKind?: "guild" | "dm";
	// Extra user ids to include in `message.mentions.users` alongside the
	// author — used to reproduce a co-mention (`@other @bot`) where the bot is
	// not the first-mentioned user.
	coMentionedUserIds?: string[];
}): Promise<{ sent: SentMessage[]; channelId: string }> {
	const channelKind = options.channelKind ?? "guild";
	// Heuristic (non-strict) proxy: the reply turn makes several model calls;
	// callers pin only the calls they need via fixtures and the proxy answers
	// the rest deterministically without hand fixtures.
	const harness = track(
		await withMockLlmRuntime({
			strict: false,
			...(options.fixtures ? { fixtures: options.fixtures } : {}),
		}),
	);
	const { runtime } = harness;

	const sent: SentMessage[] = [];

	const channelId = "1253563208833433701";
	const guildId = "1253563208833400000";
	const botMemberId = "9999999999999999999";
	const authorId = "555000111222333444";

	const author = {
		id: authorId,
		bot: false,
		username: "tester",
		globalName: "Tester",
		displayName: "Tester",
		discriminator: "0",
		displayAvatarURL: () => "https://cdn.discordapp.com/avatar.png",
		// The DM outbound seam: MessageManager resolves the user via
		// `client.users.fetch(author.id)` and calls `user.send(options)`.
		send: async (options: string | { content?: string }): Promise<unknown> => {
			const content =
				typeof options === "string" ? options : (options.content ?? "");
			sent.push({ channelId, content });
			return { id: `dm${sent.length}`, content };
		},
	};

	const captureClient = {
		user: { id: botMemberId },
		users: {
			fetch: async (id: string) => {
				if (channelKind !== "dm") {
					throw new Error(
						"client.users.fetch should not be called for a guild channel reply",
					);
				}
				if (id !== authorId) {
					throw new Error(`unexpected users.fetch for ${id}`);
				}
				return author;
			},
		},
	};

	const botMember = { id: botMemberId };
	const guild = {
		id: guildId,
		name: "Eliza Test Guild",
		ownerId: "1111111111111111111",
		members: { cache: new Map([[botMemberId, botMember]]) },
		fetch: async () => guild,
	};

	// The guild outbound seam: `sendMessageInChunks` calls `channel.send(options)`;
	// capturing it is the same surface that, in production, POSTs to Discord's
	// REST `/channels/:id/messages` endpoint.
	const channel = {
		id: channelId,
		type:
			channelKind === "dm"
				? DiscordChannelType.DM
				: DiscordChannelType.GuildText,
		name: channelKind === "dm" ? undefined : "general",
		guild: channelKind === "dm" ? undefined : guild,
		recipient: channelKind === "dm" ? author : undefined,
		client: { user: { id: botMemberId } },
		isThread: () => false,
		permissionsFor: () => ({ has: () => true }),
		send: async (options: string | { content?: string }): Promise<unknown> => {
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

	const messageId = "1253563208833433999";
	const message = {
		id: messageId,
		content: options.inboundText,
		createdTimestamp: Date.now(),
		author,
		member:
			channelKind === "dm"
				? null
				: { displayName: "Tester", nickname: undefined },
		channel,
		guild: channelKind === "dm" ? null : guild,
		url:
			channelKind === "dm"
				? `https://discord.com/channels/@me/${channelId}/${messageId}`
				: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: {
			// The bot is @mentioned but listed AFTER the co-mentioned users, so
			// `isDiscordUserAddressed` (first-mention) is false — the case where
			// the bot must still respond because it is explicitly tagged.
			users: new Map<string, { id: string }>([
				...(options.coMentionedUserIds ?? []).map(
					(id) => [id, { id }] as const,
				),
				...(options.coMentionedUserIds?.length
					? ([[botMemberId, { id: botMemberId }]] as const)
					: []),
			]),
			repliedUser: undefined,
		},
		react: async () => undefined,
		reactions: { resolve: () => null },
	} as never;

	const discordSettings: DiscordSettings = {
		autoReply: true,
		shouldRespondOnlyToMentions: false,
		shouldIgnoreBotMessages: true,
		// Guild turns pin DMs ignored (the default posture); the DM turn is the
		// surface under test and uses the open-DM policy path.
		shouldIgnoreDirectMessages: channelKind !== "dm",
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

	return { sent, channelId };
}

describe("discord connector loop (keyless harness)", () => {
	it("responds when explicitly @mentioned among other users (co-mention, bot not first)", async () => {
		// Live 2026-07-16: `@ruby @osiris @remilio` in a multi-bot channel was
		// dropped by the "targets another mentioned user" gate because the bot
		// was not the FIRST mention. An explicit tag of the bot must still get a
		// reply even when other users are co-mentioned.
		const { sent, channelId } = await driveDiscordTurn({
			inboundText: "<@2000000000000000001> <@bot> talk to them",
			coMentionedUserIds: ["2000000000000000001"],
			fixtures: [
				{
					name: "co-mention-reply",
					match: { modelType: ModelType.RESPONSE_HANDLER },
					response: {
						contexts: ["simple"],
						intents: [],
						replyText: "On it.",
						candidateActionNames: [],
					},
				},
			],
		});

		expect(
			sent.length,
			"an explicit co-mention still delivers a reply",
		).toBeGreaterThan(0);
		expect(sent[0]?.channelId).toBe(channelId);
	}, 120_000);

	it("drives a synthetic Discord message through the mock LLM to a delivered reply", async () => {
		const { sent, channelId } = await driveDiscordTurn({
			inboundText: "Hello agent, please reply.",
		});

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

	it("delivers a drifted tool-call reply to the Discord wire seam already sanitized (#15888)", async () => {
		const { sent, channelId } = await driveDiscordTurn({
			inboundText: "Say hello and describe your plan.",
			fixtures: [
				{
					name: "drifted-stage1",
					match: { modelType: ModelType.RESPONSE_HANDLER },
					// A stage-1 reply that drifted out of the response grammar into
					// native tool syntax mid-sentence — the live leak shape from
					// #15812. Lowercase tool name on purpose: the stage-1
					// junk-stripper only swallows unclosed markup followed by an
					// UPPERCASE action token, so this drift survives parsing and must
					// be caught at the shared outbound boundary in @elizaos/core.
					response: {
						contexts: ["simple"],
						intents: [],
						replyText: "The forecast looks clear.<tool_call>get_weather",
						candidateActionNames: [],
					},
				},
			],
		});

		expect(
			sent.length,
			"the connector delivered at least one outbound reply",
		).toBeGreaterThan(0);
		for (const message of sent) {
			expect(
				message.content,
				"no delivered Discord text carries native tool syntax",
			).not.toMatch(/<\/?(?:tool_call|function_call)\b/i);
		}
		expect(sent[0]?.content).toBe("The forecast looks clear.");
		expect(sent[0]?.channelId).toBe(channelId);
	}, 120_000);

	it("delivers a drifted tool-call reply to the DM seam already sanitized (#15888)", async () => {
		// The DM surface delivers through `client.users.fetch(...).send`, a
		// different wire seam from guild `channel.send` — the open-DM policy path
		// (checkDmAccess) and DM delivery must also receive shared-boundary
		// sanitized text.
		const { sent } = await driveDiscordTurn({
			channelKind: "dm",
			inboundText: "Say hello and describe your plan.",
			fixtures: [
				{
					name: "drifted-stage1-dm",
					match: { modelType: ModelType.RESPONSE_HANDLER },
					response: {
						contexts: ["simple"],
						intents: [],
						replyText: "The forecast looks clear.<tool_call>get_weather",
						candidateActionNames: [],
					},
				},
			],
		});

		expect(
			sent.length,
			"the connector delivered at least one DM reply",
		).toBeGreaterThan(0);
		for (const message of sent) {
			expect(
				message.content,
				"no delivered DM text carries native tool syntax",
			).not.toMatch(/<\/?(?:tool_call|function_call)\b/i);
		}
		expect(sent[0]?.content).toBe("The forecast looks clear.");
	}, 120_000);
});
