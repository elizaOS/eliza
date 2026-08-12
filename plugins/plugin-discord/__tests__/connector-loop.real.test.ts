/**
 * Keyless Discord connector loop e2e (#8801, gap 5 — per-plugin provider adoption).
 *
 * This is the Discord plugin's OWN copy of the connector-loop e2e, living in the
 * plugin's test dir and driven by `createTestRuntimeWithModelProvider()` from
 * `@elizaos/core/testing`. A synthetic inbound `discord.js` `Message` goes
 * through the REAL `MessageManager.handleMessage` (the same entrypoint the
 * gateway `MessageCreate` listener calls): real inbound guards, envelope
 * formatting, `ensureConnection`, then the REAL
 * `DiscordService.prototype.buildMemoryFromMessage` (constructed via
 * `Object.create(DiscordService.prototype)`, so the inbound→Memory mapping is
 * the product's own), the forced-reply turn through the deterministic deterministic model provider,
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

import {
	attestDeliveryAudienceFromCanonicalRoom,
	authorizeOwnerExclusiveDisclosure,
	ChannelType as CoreChannelType,
	createUniqueUuid,
	type Memory,
	ModelType,
	type UUID,
} from "@elizaos/core";
import {
	benignExternalMessageFixture,
	createTestRuntimeWithModelProvider,
	type DeterministicModelFixture,
	type ModelProviderTestRuntime,
} from "@elizaos/core/testing";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveElizaOwnerEntityId } from "../identity.ts";
import { MessageManager } from "../messages.ts";
import { DiscordService } from "../service.ts";
import { createTurnDrainRegistry } from "../shutdown-drain.ts";
import type { DiscordSettings, IDiscordService } from "../types.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
});

function track(harness: ModelProviderTestRuntime): ModelProviderTestRuntime {
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
	fixtures?: DeterministicModelFixture[];
	channelKind?: "guild" | "dm";
	// Extra user ids to include in `message.mentions.users` alongside the
	// author — used to reproduce a co-mention (`@other @bot`) where the bot is
	// not the first-mentioned user.
	coMentionedUserIds?: string[];
	readyGate?: Promise<void>;
	beforeReadyRelease?: (context: {
		runtime: ModelProviderTestRuntime["runtime"];
		sent: SentMessage[];
		ownerDiscordUserIds: Set<string>;
		roomId: UUID;
		authorId: string;
	}) => Promise<void>;
}): Promise<{
	sent: SentMessage[];
	channelId: string;
	runtime: ModelProviderTestRuntime["runtime"];
	roomId: UUID;
	authorId: string;
}> {
	const channelKind = options.channelKind ?? "guild";
	const harness = track(
		await createTestRuntimeWithModelProvider({
			fixtures: [
				benignExternalMessageFixture("discord-security-adjudication"),
				...(options.fixtures ?? []),
			],
		}),
	);
	const { runtime } = harness;

	const sent: SentMessage[] = [];

	// Discord channel snowflakes are globally unique. Keep the synthetic guild
	// and DM turns distinct too: the connector's process-wide outbound dedupe
	// correctly suppresses an identical account/channel/reply/text tuple inside
	// two seconds, so reusing one impossible channel identity made this harness
	// depend on whether the two tests happened to take longer than that window.
	const channelId =
		channelKind === "dm" ? "1253563208833433702" : "1253563208833433701";
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
	const ownerDiscordUserIds = new Set<string>();
	const discordService = Object.assign(
		Object.create(DiscordService.prototype),
		{
			runtime,
			client: captureClient,
			clientReadyPromise: options.readyGate ?? null,
			accountId: "default",
			defaultAccountId: "default",
			discordSettings,
			ownerDiscordUserIds,
			accountPool: { get: () => null, getDefault: () => null },
			turnDrainRegistry: createTurnDrainRegistry(),
			// The shutdown cordon field is a constructor-initialized class field;
			// `Object.create` skips the constructor, and `admitInboundMessage`
			// treats anything other than exactly `null` as a closed ingress, so
			// the harness must open it explicitly.
			ingressClosedReason: null,
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
	const turn = manager.handleMessage(message);
	if (options.beforeReadyRelease) {
		await options.beforeReadyRelease({
			runtime,
			sent,
			ownerDiscordUserIds,
			roomId: createUniqueUuid(runtime, channelId),
			authorId,
		});
	}
	await turn;

	return {
		sent,
		channelId,
		runtime,
		roomId: createUniqueUuid(runtime, channelId),
		authorId,
	};
}

describe("discord connector loop (deterministic model-provider runtime)", () => {
	it("waits for ready-time owner hydration before DM identity, recall authorization, and one send", async () => {
		let releaseReady!: () => void;
		const readyGate = new Promise<void>((resolve) => {
			releaseReady = resolve;
		});

		const result = await driveDiscordTurn({
			channelKind: "dm",
			inboundText:
				"Remember that my launch phrase is solar key, then reply once.",
			fixtures: [
				{
					name: "owner-readiness-reply",
					match: { modelType: ModelType.RESPONSE_HANDLER },
					response: {
						contexts: ["simple"],
						intents: [],
						replyText: "Ready.",
						candidateActionNames: [],
					},
				},
			],
			readyGate,
			beforeReadyRelease: async ({
				runtime,
				sent,
				ownerDiscordUserIds,
				roomId,
				authorId,
			}) => {
				// ClientReady has fired, but onReady is still hydrating application
				// ownership. No identity/room/memory/send side effect may race ahead.
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(sent).toHaveLength(0);
				expect(await runtime.getRoom(roomId)).toBeNull();

				// Mirrors refreshOwnerDiscordUserIds completing before onReady resolves.
				ownerDiscordUserIds.add(authorId);
				releaseReady();
			},
		});

		expect(result.sent).toHaveLength(1);
		const canonicalOwnerId = resolveElizaOwnerEntityId(result.runtime) as UUID;
		const participants = await result.runtime.getParticipantsForRoom(
			result.roomId,
		);
		expect(new Set(participants)).toEqual(
			new Set([canonicalOwnerId, result.runtime.agentId]),
		);

		const memories = await result.runtime.getMemories({
			roomId: result.roomId,
			tableName: "messages",
			count: 20,
		});
		const inbound = memories.find(
			(memory) => memory.entityId === canonicalOwnerId,
		);
		expect(inbound?.content.text).toContain("solar key");
		if (!inbound) throw new Error("canonical owner memory was not persisted");

		// The exact canonical DM room written by Discord authorizes owner-private
		// recall. Adding any third participant invalidates that authorization.
		await attestDeliveryAudienceFromCanonicalRoom(result.runtime, inbound);
		expect(
			(await authorizeOwnerExclusiveDisclosure(result.runtime, inbound))
				.allowed,
		).toBe(true);

		const guestId = createUniqueUuid(result.runtime, "discord-cutover-guest");
		await result.runtime.ensureConnection({
			entityId: guestId,
			roomId: result.roomId,
			userName: "guest",
			name: "Guest",
			source: "discord",
			channelId: result.channelId,
			type: CoreChannelType.DM,
			worldId: result.roomId,
		});
		const groupProbe: Memory = {
			id: createUniqueUuid(result.runtime, "probe"),
			entityId: canonicalOwnerId,
			agentId: result.runtime.agentId,
			roomId: result.roomId,
			content: { text: "recall solar key", source: "discord" },
			createdAt: Date.now(),
		};
		await attestDeliveryAudienceFromCanonicalRoom(result.runtime, groupProbe);
		expect(
			(await authorizeOwnerExclusiveDisclosure(result.runtime, groupProbe))
				.allowed,
		).toBe(false);
	}, 120_000);

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

	it("drives a synthetic Discord message through the deterministic model provider to a delivered reply", async () => {
		const { sent, channelId } = await driveDiscordTurn({
			inboundText: "Hello agent, please reply.",
			fixtures: [
				{
					name: "discord-reply",
					match: { modelType: ModelType.RESPONSE_HANDLER },
					response: {
						contexts: ["simple"],
						intents: [],
						replyText: "Hello from the deterministic model provider.",
						candidateActionNames: [],
					},
				},
			],
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
