/**
 * Manager-level coordination tests against the REAL durable path.
 *
 * Two real `MessageManager` instances (distinct agents, distinct Discord
 * clients) share ONE plugin-sql/PGlite database and race the same guild
 * message. Only the Discord network objects are stubbed; every coordination
 * decision goes through the production `messages.ts` path against the migrated
 * coordination schema and the real SQL executor.
 *
 * This suite deliberately lives on the SQL path rather than an in-process
 * shared-map fake: the earlier mock-store version of these tests passed while
 * `runtime.db` was absent, so it proved the WeakMap fallback (which the flag now
 * refuses to use) instead of the durable protocol it claimed to cover.
 *
 * Covered here:
 *   (a) two agents race one human edge   -> exactly one third-party send
 *   (b) newer human edge mid-generation  -> holder aborts before send
 *   (c) explicit mention                 -> addressed work is never dropped
 *   (d) bot message not addressed        -> suppressed (no loop)
 *   (e) bot-reply budget                 -> the human answer does NOT spend it
 *   (f) redelivery/retry                 -> cannot double-send
 *   (g) IGNORE/no-reply                  -> slot released, not resurrected
 */
import { randomUUID } from "node:crypto";
import {
	type Content,
	ChannelType,
	createUniqueUuid,
	type Memory,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as discordCoordinationSchema from "../coordination-schema.ts";
import { deterministicCoordinationNonce } from "../group-coordination.ts";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";
import { createTestRuntime, type TestRuntimeResult } from "./helpers/pglite-runtime.ts";

const AGENT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" as UUID;
const AGENT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" as UUID;
const HUMAN_ID = "555000111222333444";
const OTHER_BOT_ID = "666000111222333444";
const GUILD_ID = "888111000000000000";
const CLIENT_A = "999000000000000001";
const CLIENT_B = "999000000000000002";
const SERVER_ID = stringToUuid("p4-manager-coordination-server") as UUID;
const TRUST_GROUP_ID = "p4-manager-trust-group";

let testRuntime: TestRuntimeResult;
/** The single real SQL-backed runtime every contender writes through. */
let baseRuntime: TestRuntimeResult["runtime"];

interface Sent {
	agent: UUID;
	content: string;
	nonce?: string | number;
	enforceNonce?: boolean;
}

type SqlRunner = { execute(query: unknown): Promise<{ rows: unknown[] }> };

function db(): SqlRunner {
	return baseRuntime.db as unknown as SqlRunner;
}

beforeAll(async () => {
	// The coordination tables are owned by the plugin schema (never runtime DDL)
	// so plugin-sql's RLS pass can apply the tenant policy; migrate them through
	// the real migration service exactly as production does.
	testRuntime = await createTestRuntime({
		plugins: [
			{
				name: "discord-coordination-schema",
				description: "Discord group-room coordination tables (test registration)",
				schema: discordCoordinationSchema,
			},
		],
	});
	baseRuntime = testRuntime.runtime;
}, 180_000);

afterAll(async () => {
	await testRuntime.cleanup();
});

/**
 * A contender runtime: its own agentId and runtime-instance identity, sharing
 * the ONE real database. This is exactly the production shape of two agents
 * coordinating over a common coordination schema.
 */
function makeRuntime(
	agentId: UUID,
	runtimeInstanceId: string,
	options?: {
		onGenerate?: (invocation: number) => Promise<void> | void;
		replyText?: string | null;
	},
): ICompatRuntime {
	let generateCalls = 0;
	const memories = new Map<string, Memory>();
	const runtime = {
		agentId,
		character: { name: `Agent-${agentId.slice(0, 4)}` },
		db: baseRuntime.db,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getSetting: (key: string) => {
			const settings: Record<string, string> = {
				ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
				DISCORD_GROUP_COORDINATION_ENABLED: "true",
				DISCORD_GROUP_COORDINATION_SERVER_ID: SERVER_ID,
				DISCORD_GROUP_COORDINATION_TRUST_GROUP_ID: TRUST_GROUP_ID,
				// Operator-declared roster: trust is never self-minted.
				DISCORD_COORDINATION_TRUST_MEMBERS: `${AGENT_A},${AGENT_B}`,
				ELIZA_RUNTIME_INSTANCE_ID: runtimeInstanceId,
				DISCORD_ENVELOPE_ENABLED: "false",
				DISCORD_STATUS_REACTIONS: "none",
				// The sweeper is exercised directly in the protocol suite; an
				// interval here would race these assertions.
				DISCORD_COORDINATION_SWEEP_MS: "0",
			};
			return settings[key];
		},
		getService: () => null,
		reportError: vi.fn(),
		emitEvent: vi.fn(),
		ensureConnection: vi.fn(async () => {}),
		getMemoryById: vi.fn(async (id: UUID) => memories.get(id as string) ?? null),
		createMemory: vi.fn(async (memory: Memory, _table = "messages") => {
			const id = (memory.id ?? randomUUID()) as string;
			memories.set(id, { ...memory, id: id as UUID });
			return id as UUID;
		}),
		getMemories: vi.fn(async () => []),
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				_message: Memory,
				callback: (content: Content) => Promise<unknown>,
			) => {
				generateCalls += 1;
				await options?.onGenerate?.(generateCalls);
				if (options?.replyText === null) {
					// Deliberate no-reply (IGNORE), the shape that must release the slot.
					return;
				}
				await callback({
					text: options?.replyText ?? "coordinated reply",
					source: "discord",
				});
			},
		},
	} as unknown as ICompatRuntime;
	return runtime;
}

function makeGuildChannel(
	agent: UUID,
	clientId: string,
	channelId: string,
	sends: Sent[],
) {
	const guild = {
		id: GUILD_ID,
		name: "Coordination Guild",
		ownerId: HUMAN_ID,
		members: { cache: new Map([[clientId, { id: clientId }]]) },
	};
	const channel = {
		id: channelId,
		type: DiscordChannelType.GuildText,
		name: "multiplayer",
		guild,
		client: { user: { id: clientId } },
		isThread: () => false,
		permissionsFor: () => ({ has: () => true }),
		send: async (
			options:
				| string
				| {
						content?: string;
						nonce?: string | number;
						enforceNonce?: boolean;
					},
		) => {
			const content =
				typeof options === "string" ? options : (options.content ?? "");
			sends.push({
				agent,
				content,
				...(typeof options === "object"
					? { nonce: options.nonce, enforceNonce: options.enforceNonce }
					: {}),
			});
			const id = `9900000000000${sends.length}`;
			return {
				id,
				content,
				url: `https://discord.com/channels/${GUILD_ID}/${channelId}/${id}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
			};
		},
	};
	return { guild, channel };
}

function makeInbound(options: {
	channel: unknown;
	guild: unknown;
	channelId: string;
	messageId: string;
	text?: string;
	authorId?: string;
	authorIsBot?: boolean;
	mentionsBotId?: string;
	createdTimestamp?: number;
}): DiscordMessage {
	const users = new Map<string, { id: string }>();
	if (options.mentionsBotId) {
		users.set(options.mentionsBotId, { id: options.mentionsBotId });
	}
	return {
		id: options.messageId,
		content:
			options.text ??
			(options.mentionsBotId
				? `<@${options.mentionsBotId}> hello there`
				: "hello there"),
		createdTimestamp: options.createdTimestamp ?? Date.now(),
		author: {
			id: options.authorId ?? HUMAN_ID,
			bot: options.authorIsBot ?? false,
			username: options.authorIsBot ? "otherbot" : "shadow",
			globalName: options.authorIsBot ? "OtherBot" : "Shadow",
			displayName: options.authorIsBot ? "OtherBot" : "Shadow",
			discriminator: "0",
			displayAvatarURL: () => "https://cdn.example/avatar.png",
		},
		member: { displayName: options.authorIsBot ? "OtherBot" : "Shadow" },
		channel: options.channel,
		guild: options.guild,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: { users, repliedUser: undefined },
		react: async () => undefined,
		reactions: { resolve: () => null },
	} as unknown as DiscordMessage;
}

function makeService(
	runtime: ICompatRuntime,
	clientId: string,
	channelId: string,
	options?: { shouldIgnoreBotMessages?: boolean },
): IDiscordService {
	return {
		client: {
			user: { id: clientId },
			// The sweeper only recovers channels this client can reach.
			channels: { cache: new Map([[channelId, { id: channelId }]]) },
		},
		accountId: "default",
		getChannelType: async () => ChannelType.GROUP,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: options?.shouldIgnoreBotMessages ?? true,
			shouldIgnoreDirectMessages: false,
			shouldRespondOnlyToMentions: false,
			replyToMode: "off",
		},
		buildMemoryFromMessage: vi.fn(async (message: DiscordMessage) => ({
			id: createUniqueUuid(runtime, message.id),
			entityId: createUniqueUuid(runtime, message.author.id),
			agentId: runtime.agentId,
			roomId: createUniqueUuid(runtime, channelId),
			content: { text: message.content, source: "discord" },
		})),
	} as unknown as IDiscordService;
}

async function receiptsFor(
	channelId: string,
	kind?: string,
): Promise<Record<string, unknown>[]> {
	const result = kind
		? await db().execute(sql`
				SELECT * FROM discord_coordination_receipts
				WHERE channel_id = ${channelId} AND kind = ${kind}
				ORDER BY created_at ASC
			`)
		: await db().execute(sql`
				SELECT * FROM discord_coordination_receipts
				WHERE channel_id = ${channelId}
				ORDER BY created_at ASC
			`);
	return result.rows as Record<string, unknown>[];
}

async function slotsFor(channelId: string): Promise<Record<string, unknown>[]> {
	const result = await db().execute(sql`
		SELECT * FROM discord_coordination_reply_slots
		WHERE channel_id = ${channelId}
		ORDER BY lane ASC, slot_index ASC
	`);
	return result.rows as Record<string, unknown>[];
}

/** Distinct channel per test: the coordination state is channel-scoped. */
function freshChannelId(): string {
	return String(700000000000000000n + BigInt(Math.floor(Math.random() * 1e15)));
}

describe("group coordination on the real SQL path — two agents race one human edge", () => {
	it("exactly one agent speaks; both leave lease-claim receipts, one slot row", async () => {
		const channelId = freshChannelId();
		const sends: Sent[] = [];

		const runtimeA = makeRuntime(AGENT_A, "instance-a", {
			onGenerate: () => new Promise((resolve) => setTimeout(resolve, 20)),
		});
		const runtimeB = makeRuntime(AGENT_B, "instance-b", {
			onGenerate: () => new Promise((resolve) => setTimeout(resolve, 20)),
		});
		const chanA = makeGuildChannel(AGENT_A, CLIENT_A, channelId, sends);
		const chanB = makeGuildChannel(AGENT_B, CLIENT_B, channelId, sends);
		const managerA = new MessageManager(
			makeService(runtimeA, CLIENT_A, channelId),
			runtimeA,
		);
		const managerB = new MessageManager(
			makeService(runtimeB, CLIENT_B, channelId),
			runtimeB,
		);

		const messageId = "222000000000000001";
		await Promise.all([
			managerA.handleMessage(
				makeInbound({
					channel: chanA.channel,
					guild: chanA.guild,
					channelId,
					messageId,
				}),
			),
			managerB.handleMessage(
				makeInbound({
					channel: chanB.channel,
					guild: chanB.guild,
					channelId,
					messageId,
				}),
			),
		]);

		expect(sends).toHaveLength(1);
		// The production Discord send is idempotency-fenced at the provider too:
		// retries use the same deterministic nonce and Discord rejects duplicates.
		expect(sends[0]?.enforceNonce).toBe(true);
		expect(String(sends[0]?.nonce)).toHaveLength(24);

		const claims = await receiptsFor(channelId, "lease-claim");
		expect(claims).toHaveLength(2);
		expect(claims.map((row) => row.outcome).sort()).toEqual(["lost", "won"]);
		// Both contenders agree on the holder token recorded in the row.
		expect(new Set(claims.map((row) => row.holder_token)).size).toBe(1);

		// Exactly one human-lane slot row, and it is the delivered one.
		const slots = await slotsFor(channelId);
		expect(slots).toHaveLength(1);
		expect(slots[0].lane).toBe("human");
		expect(slots[0].state).toBe("delivered");
		expect(slots[0].delivered_message_id).toBeTruthy();
		expect(String(sends[0]?.nonce)).toBe(
			deterministicCoordinationNonce(
				{
					serverId: String(slots[0].server_id) as UUID,
					trustGroupId: String(slots[0].trust_group_id),
					channelId: String(slots[0].channel_id),
					edgeEpoch: String(slots[0].edge_epoch),
					lane: String(slots[0].lane) === "bot" ? "bot" : "human",
					generation: Number(slots[0].slot_index),
				},
				"0",
			),
		);
	});
});

describe("group coordination on the real SQL path — latest-human-edge-wins", () => {
	it("a newer human edge during generation aborts the send and releases the slot", async () => {
		const channelId = freshChannelId();
		const sends: Sent[] = [];

		// Second agent's manager stands in for the gateway that observes the newer
		// human message: noteHumanEdge is the production hook messageCreate calls.
		const observerRuntime = makeRuntime(AGENT_B, "instance-observer");
		const observer = new MessageManager(
			makeService(observerRuntime, CLIENT_B, channelId),
			observerRuntime,
		);

		const runtime = makeRuntime(AGENT_A, "instance-a", {
			onGenerate: async () => {
				await observer.noteHumanEdge(
					channelId,
					"222000000000000009",
					Date.now() + 1,
				);
			},
		});
		const chan = makeGuildChannel(AGENT_A, CLIENT_A, channelId, sends);
		const manager = new MessageManager(
			makeService(runtime, CLIENT_A, channelId),
			runtime,
		);

		await manager.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId: "222000000000000002",
			}),
		);

		expect(sends).toHaveLength(0);
		const aborts = await receiptsFor(channelId, "stale-edge-abort");
		expect(aborts).toHaveLength(1);
		expect(aborts[0].outcome).toBe("pre-send");

		// The abandoned claim is RELEASED, not left `claimed` to expire: otherwise
		// the crash sweeper would resurrect an edge we deliberately dropped.
		const slots = await slotsFor(channelId);
		const abandoned = slots.find(
			(slot) => slot.inbound_message_id === "222000000000000002",
		);
		expect(abandoned?.state).toBe("released");
		expect(abandoned?.delivered_message_id).toBeNull();
	});

	it("fences the provider-error reply after a newer human edge", async () => {
		const channelId = freshChannelId();
		const sends: Sent[] = [];
		const observerRuntime = makeRuntime(AGENT_B, "instance-observer");
		const observer = new MessageManager(
			makeService(observerRuntime, CLIENT_B, channelId),
			observerRuntime,
		);
		const runtime = makeRuntime(AGENT_A, "instance-a", {
			onGenerate: async () => {
				await observer.noteHumanEdge(
					channelId,
					"222000000000000029",
					Date.now() + 1,
				);
				throw new Error("provider exploded");
			},
		});
		const chan = makeGuildChannel(AGENT_A, CLIENT_A, channelId, sends);
		const manager = new MessageManager(
			makeService(runtime, CLIENT_A, channelId),
			runtime,
		);

		await manager.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId: "222000000000000020",
			}),
		);

		// The normal callback never ran; this specifically proves the catch-path
		// fallback is fenced immediately before channel.send.
		expect(sends).toHaveLength(0);
		const aborts = await receiptsFor(channelId, "stale-edge-abort");
		expect(aborts).toHaveLength(1);
		expect(aborts[0].outcome).toBe("failure-reply");
		const slots = await slotsFor(channelId);
		expect(slots[0]?.state).toBe("released");
	});

	it("explicit mention overrides edge staleness — addressed work still sends", async () => {
		const channelId = freshChannelId();
		const sends: Sent[] = [];

		const observerRuntime = makeRuntime(AGENT_B, "instance-observer");
		const observer = new MessageManager(
			makeService(observerRuntime, CLIENT_B, channelId),
			observerRuntime,
		);
		const runtime = makeRuntime(AGENT_A, "instance-a", {
			onGenerate: async () => {
				await observer.noteHumanEdge(
					channelId,
					"222000000000000019",
					Date.now() + 1,
				);
			},
		});
		const chan = makeGuildChannel(AGENT_A, CLIENT_A, channelId, sends);
		const manager = new MessageManager(
			makeService(runtime, CLIENT_A, channelId),
			runtime,
		);

		await manager.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId: "222000000000000003",
				mentionsBotId: CLIENT_A,
			}),
		);

		expect(sends).toHaveLength(1);
		expect(await receiptsFor(channelId, "stale-edge-abort")).toHaveLength(0);
	});
});

describe("group coordination on the real SQL path — bot-to-bot loop prevention", () => {
	it("suppresses an unaddressed bot message (ingest only, receipt written)", async () => {
		const channelId = freshChannelId();
		const sends: Sent[] = [];
		const runtime = makeRuntime(AGENT_A, "instance-a");
		const chan = makeGuildChannel(AGENT_A, CLIENT_A, channelId, sends);
		const manager = new MessageManager(
			makeService(runtime, CLIENT_A, channelId, {
				shouldIgnoreBotMessages: false,
			}),
			runtime,
		);

		await manager.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId: "222000000000000004",
				authorId: OTHER_BOT_ID,
				authorIsBot: true,
			}),
		);

		expect(sends).toHaveLength(0);
		const suppressions = await receiptsFor(channelId, "bot-loop-suppress");
		expect(suppressions).toHaveLength(1);
		expect(suppressions[0].outcome).toBe("not-addressed");
	});

	it("answering the human does NOT spend the bot-reply budget for that edge", async () => {
		const channelId = freshChannelId();
		const sends: Sent[] = [];
		const runtime = makeRuntime(AGENT_A, "instance-a");
		const chan = makeGuildChannel(AGENT_A, CLIENT_A, channelId, sends);
		const manager = new MessageManager(
			makeService(runtime, CLIENT_A, channelId, {
				shouldIgnoreBotMessages: false,
			}),
			runtime,
		);

		// Human sets the edge and is answered: this consumes the HUMAN lane.
		await manager.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId: "222000000000000005",
				createdTimestamp: 1_000,
			}),
		);
		expect(sends).toHaveLength(1);

		// First addressed bot message under the same edge: the bot lane is still
		// free, so this must be answered. With a shared lane the human answer had
		// already exhausted budget=1 and this reply was wrongly suppressed.
		await manager.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId: "222000000000000006",
				authorId: OTHER_BOT_ID,
				authorIsBot: true,
				mentionsBotId: CLIENT_A,
			}),
		);
		expect(sends).toHaveLength(2);

		// Second addressed bot message before any human speaks: bot lane spent.
		await manager.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId: "222000000000000007",
				authorId: OTHER_BOT_ID,
				authorIsBot: true,
				mentionsBotId: CLIENT_A,
			}),
		);
		expect(sends).toHaveLength(2);
		const suppressions = await receiptsFor(channelId, "bot-loop-suppress");
		expect(suppressions).toHaveLength(1);
		expect(suppressions[0].outcome).toBe("budget-exhausted");

		// One slot per lane, both terminal.
		const slots = await slotsFor(channelId);
		expect(slots.map((slot) => slot.lane).sort()).toEqual(["bot", "human"]);
	});
});

describe("group coordination on the real SQL path — retry and no-reply", () => {
	it("redelivery after a successful send does not double-send", async () => {
		const channelId = freshChannelId();
		const sends: Sent[] = [];
		const runtime = makeRuntime(AGENT_A, "instance-a");
		const chan = makeGuildChannel(AGENT_A, CLIENT_A, channelId, sends);
		const service = makeService(runtime, CLIENT_A, channelId);
		const messageId = "222000000000000008";

		const manager = new MessageManager(service, runtime);
		await manager.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId,
			}),
		);
		expect(sends).toHaveLength(1);

		// Simulated restart: fresh manager (new runtime-instance identity), same
		// durable rows. The delivered slot is terminal, so the redelivery cannot
		// reclaim it and cannot send again.
		const restartRuntime = makeRuntime(AGENT_A, "instance-a-restarted");
		const restarted = new MessageManager(
			makeService(restartRuntime, CLIENT_A, channelId),
			restartRuntime,
		);
		await restarted.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId,
			}),
		);
		expect(sends).toHaveLength(1);

		const slots = await slotsFor(channelId);
		expect(slots).toHaveLength(1);
		expect(slots[0].state).toBe("delivered");
	});

	it("a deliberate no-reply releases the slot instead of leaving it claimed", async () => {
		const channelId = freshChannelId();
		const sends: Sent[] = [];
		// replyText null => the agent generates nothing (IGNORE).
		const runtime = makeRuntime(AGENT_A, "instance-a", { replyText: null });
		const chan = makeGuildChannel(AGENT_A, CLIENT_A, channelId, sends);
		const manager = new MessageManager(
			makeService(runtime, CLIENT_A, channelId),
			runtime,
		);

		await manager.handleMessage(
			makeInbound({
				channel: chan.channel,
				guild: chan.guild,
				channelId,
				messageId: "222000000000000010",
			}),
		);

		expect(sends).toHaveLength(0);
		const slots = await slotsFor(channelId);
		expect(slots).toHaveLength(1);
		// Left `claimed`, this would expire and the sweeper would re-dispatch an
		// edge the agent chose not to answer, forever.
		expect(slots[0].state).toBe("released");
	});
});
