/**
 * Real PGlite coverage for canonical connector memory recall. The test writes
 * production `messages` rows through `AgentRuntime.createMemory`, recalls them
 * through `searchCanonicalConversationMemories`, and derives cross-room
 * permission from the trusted delivery-audience gate against live room state.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMessageMemory } from "../memory";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	ownerExclusiveDisclosureWasUsed,
	ownerExclusiveSuppressionNote,
	revalidateOwnerExclusiveDisclosure,
} from "../security/trusted-delivery-audience";
import {
	createTestRuntime,
	type TestRuntimeResult,
} from "../testing/pglite-runtime";
import { ChannelType, type Memory, type UUID } from "../types";
import { stringToUuid } from "../utils";
import { searchCanonicalConversationMemories } from "./provenance-envelope";

const OWNER = "11111111-1111-1111-1111-111111111111" as UUID;
const GUEST = "33333333-3333-3333-3333-333333333333" as UUID;
const DISCORD_ROOM = "44444444-4444-4444-4444-444444444444" as UUID;
const TELEGRAM_ROOM = "55555555-5555-5555-5555-555555555555" as UUID;
const OWNER_DM_ROOM = "66666666-6666-6666-6666-666666666666" as UUID;
const GROUP_ROOM = "77777777-7777-7777-7777-777777777777" as UUID;
const WORLD = "88888888-8888-8888-8888-888888888888" as UUID;

function vector(seed: number): number[] {
	const embedding = Array(384).fill(0);
	embedding[0] = seed;
	return embedding;
}

function canonicalMessage(args: {
	id: UUID;
	entityId: UUID;
	roomId: UUID;
	source: "discord" | "telegram";
	accountId: string;
	platformMessageId: string;
	text: string;
	embedding: number[];
}): Memory {
	const memory = createMessageMemory({
		id: args.id,
		entityId: args.entityId,
		roomId: args.roomId,
		content: {
			text: args.text,
			source: args.source,
			channelType: ChannelType.DM,
		},
		embedding: args.embedding,
	});
	memory.metadata = {
		type: "message",
		timestamp: memory.createdAt,
		scope: "private",
		provider: args.source,
		accountId: args.accountId,
		platformMessageId: args.platformMessageId,
		sourceId: args.platformMessageId,
		[args.source]: {
			id: args.entityId,
			userId: args.entityId,
			accountId: args.accountId,
			messageId: args.platformMessageId,
		},
	};
	return memory as Memory;
}

describe("canonical connector memory recall on AgentRuntime + PGlite", () => {
	let testRuntime: TestRuntimeResult | undefined;

	beforeEach(async () => {
		// The restart case below reopens the same data dir with a second
		// runtime, so this suite needs a real on-disk store rather than the
		// helper's default in-memory database.
		testRuntime = await createTestRuntime({
			characterName: "CanonicalMemoryAgent",
			pgliteDir: fs.mkdtempSync(
				path.join(os.tmpdir(), "eliza-canonical-memory-"),
			),
			removePgliteDirOnCleanup: false,
		});
		testRuntime.runtime.character.settings = {
			...(testRuntime.runtime.character.settings ?? {}),
			ELIZA_ADMIN_ENTITY_ID: OWNER,
		};
	}, 180_000);

	afterEach(async () => {
		if (testRuntime) {
			const { pgliteDir, cleanup } = testRuntime;
			await cleanup();
			fs.rmSync(pgliteDir, { recursive: true, force: true });
			testRuntime = undefined;
		}
	});

	async function ensureRoom(
		roomId: UUID,
		entityId: UUID,
		type: ChannelType,
		source: string,
	): Promise<void> {
		if (!testRuntime) throw new Error("runtime not initialized");
		await testRuntime.runtime.ensureConnection({
			entityId,
			roomId,
			userName: entityId,
			source,
			type,
			worldId: WORLD,
			worldName: "Canonical memory test world",
			channelId: `${source}:${roomId}`,
		});
	}

	it("recalls and dedupes across Discord and Telegram only after owner-private audience revalidation", async () => {
		if (!testRuntime) throw new Error("runtime not initialized");
		const { runtime, pgliteDir } = testRuntime;
		await ensureRoom(DISCORD_ROOM, OWNER, ChannelType.DM, "discord");
		await ensureRoom(TELEGRAM_ROOM, OWNER, ChannelType.DM, "telegram");
		await ensureRoom(OWNER_DM_ROOM, OWNER, ChannelType.DM, "telegram");
		await runtime.createMemory(
			canonicalMessage({
				id: stringToUuid("discord-first"),
				entityId: OWNER,
				roomId: DISCORD_ROOM,
				source: "discord",
				accountId: "discord-main",
				platformMessageId: "discord-message-1",
				text: "Discord says the launch code is soliza-alpha.",
				embedding: vector(1),
			}),
			"messages",
		);
		await runtime.createMemory(
			canonicalMessage({
				id: stringToUuid("discord-redelivery"),
				entityId: OWNER,
				roomId: DISCORD_ROOM,
				source: "discord",
				accountId: "discord-main",
				platformMessageId: "discord-message-1",
				text: "Discord duplicate delivery should dedupe.",
				embedding: vector(1),
			}),
			"messages",
		);
		await runtime.createMemory(
			canonicalMessage({
				id: stringToUuid("telegram-first"),
				entityId: OWNER,
				roomId: TELEGRAM_ROOM,
				source: "telegram",
				accountId: "telegram-main",
				platformMessageId: "telegram-message-9",
				text: "Telegram says the launch code is soliza-beta.",
				embedding: vector(0.95),
			}),
			"messages",
		);

		const ownerTurn = createMessageMemory({
			entityId: OWNER,
			agentId: runtime.agentId,
			roomId: OWNER_DM_ROOM,
			content: { text: "what launch codes did I mention?", source: "telegram" },
		});
		await attestDeliveryAudienceFromCanonicalRoom(runtime, ownerTurn);
		const ownerDecision = await revalidateOwnerExclusiveDisclosure(
			runtime,
			ownerTurn,
		);
		expect(ownerDecision.allowed).toBe(true);
		expect(ownerExclusiveDisclosureWasUsed(ownerTurn)).toBe(false);

		const allowedRecall = await searchCanonicalConversationMemories({
			runtime,
			embedding: vector(1),
			query: "launch code",
			agentId: runtime.agentId,
			deliveryMessage: ownerTurn,
			count: 10,
			matchThreshold: 0,
		});

		expect(allowedRecall.items.map((item) => item.dedupeKey).sort()).toEqual([
			`discord:discord-main:${DISCORD_ROOM}:discord-message-1`,
			`telegram:telegram-main:${TELEGRAM_ROOM}:telegram-message-9`,
		]);
		expect(
			allowedRecall.items.map((item) => item.memory.content.text),
		).toContain("Discord says the launch code is soliza-alpha.");
		expect(ownerExclusiveDisclosureWasUsed(ownerTurn)).toBe(true);

		await testRuntime.cleanup();
		testRuntime = await createTestRuntime({
			characterName: "CanonicalMemoryAgent",
			pgliteDir,
			removePgliteDirOnCleanup: false,
		});
		testRuntime.runtime.character.settings = {
			...(testRuntime.runtime.character.settings ?? {}),
			ELIZA_ADMIN_ENTITY_ID: OWNER,
		};
		const afterRestart = await testRuntime.runtime.getMemories({
			tableName: "messages",
			roomId: DISCORD_ROOM,
			limit: 10,
			includeEmbedding: false,
		});
		expect(afterRestart.map((memory) => memory.metadata)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					provider: "discord",
					accountId: "discord-main",
					platformMessageId: "discord-message-1",
				}),
			]),
		);
	});

	it("denies private cross-surface recall into a live group room", async () => {
		if (!testRuntime) throw new Error("runtime not initialized");
		const { runtime } = testRuntime;
		await ensureRoom(DISCORD_ROOM, OWNER, ChannelType.DM, "discord");
		await ensureRoom(GROUP_ROOM, OWNER, ChannelType.GROUP, "discord");
		await ensureRoom(GROUP_ROOM, GUEST, ChannelType.GROUP, "discord");
		await runtime.createMemory(
			canonicalMessage({
				id: stringToUuid("private-discord"),
				entityId: OWNER,
				roomId: DISCORD_ROOM,
				source: "discord",
				accountId: "discord-main",
				platformMessageId: "private-discord-message",
				text: "Private Discord note: payroll is Friday.",
				embedding: vector(1),
			}),
			"messages",
		);

		const groupTurn = createMessageMemory({
			entityId: OWNER,
			agentId: runtime.agentId,
			roomId: GROUP_ROOM,
			content: {
				text: "what private payroll note did I mention?",
				source: "discord",
			},
		});
		await attestDeliveryAudienceFromCanonicalRoom(runtime, groupTurn);
		const groupDecision = await revalidateOwnerExclusiveDisclosure(
			runtime,
			groupTurn,
		);
		expect(groupDecision).toMatchObject({
			allowed: false,
			reason: "participant_mismatch",
		});

		const deniedRecall = await searchCanonicalConversationMemories({
			runtime,
			embedding: vector(1),
			query: "payroll",
			agentId: runtime.agentId,
			deliveryMessage: groupTurn,
			count: 10,
			matchThreshold: 0,
		});

		expect(deniedRecall.items).toEqual([]);
		// The denied cross-room row is excluded by the room-constrained adapter
		// query, so it is neither returned nor exposed through diagnostics.
		expect(deniedRecall.withheld).toEqual([]);
		expect(deniedRecall.availability).toBe("complete");
		expect(deniedRecall.candidateWindowComplete).toBe(true);
		expect(ownerExclusiveDisclosureWasUsed(groupTurn)).toBe(false);
		expect(ownerExclusiveSuppressionNote(groupTurn)).toBeUndefined();
	});

	it("does not taint egress for same-room-only owner-private searches", async () => {
		if (!testRuntime) throw new Error("runtime not initialized");
		const { runtime } = testRuntime;
		await ensureRoom(OWNER_DM_ROOM, OWNER, ChannelType.DM, "telegram");
		await runtime.createMemory(
			canonicalMessage({
				id: stringToUuid("same-room-telegram"),
				entityId: OWNER,
				roomId: OWNER_DM_ROOM,
				source: "telegram",
				accountId: "telegram-main",
				platformMessageId: "same-room-telegram-message",
				text: "Same-room note: the package is under the blue mat.",
				embedding: vector(1),
			}),
			"messages",
		);

		const ownerTurn = createMessageMemory({
			entityId: OWNER,
			agentId: runtime.agentId,
			roomId: OWNER_DM_ROOM,
			content: {
				text: "where is the package?",
				source: "telegram",
			},
		});
		await attestDeliveryAudienceFromCanonicalRoom(runtime, ownerTurn);

		const sameRoomRecall = await searchCanonicalConversationMemories({
			runtime,
			embedding: vector(1),
			query: "package",
			agentId: runtime.agentId,
			deliveryMessage: ownerTurn,
			count: 10,
			matchThreshold: 0,
		});

		expect(sameRoomRecall.items.map((item) => item.dedupeKey)).toEqual([
			`telegram:telegram-main:${OWNER_DM_ROOM}:same-room-telegram-message`,
		]);
		expect(sameRoomRecall.withheld).toEqual([]);
		expect(sameRoomRecall.availability).toBe("complete");
		expect(ownerExclusiveDisclosureWasUsed(ownerTurn)).toBe(false);

		await ensureRoom(OWNER_DM_ROOM, GUEST, ChannelType.DM, "telegram");
		await expect(
			revalidateOwnerExclusiveDisclosure(runtime, ownerTurn),
		).resolves.toMatchObject({
			allowed: false,
			reason: "audience_changed",
		});
		expect(ownerExclusiveDisclosureWasUsed(ownerTurn)).toBe(false);
	});
});
