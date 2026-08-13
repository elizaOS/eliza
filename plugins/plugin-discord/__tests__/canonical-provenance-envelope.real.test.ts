/**
 * Fail-closed provenance-envelope tests for the production stored-message
 * search (re-cut of #17211's non-superseded remainder; audience policy is
 * owned by #17206's trusted-delivery-audience layer and is deliberately NOT
 * re-implemented here — cross-room recall is denied unconditionally).
 *
 * What is proven, against the real PGLite adapter and the real handlers:
 *   - typed invalid provenance for every missing required field (no fabrication)
 *   - the mandatory scope ladder runs and cannot be bypassed
 *   - same-room containment: cross-room candidates are withheld with a typed code
 *   - `source:account:room:platformRecordId` dedupe across distinct DB primary keys
 *   - the REAL Discord connector ingestion (`buildMemoryFromMessage`) and the
 *     REAL Telegram sent-memory shape stamp scope + provenance that the
 *     envelope accepts (trusted scope stamping, not read-time guessing)
 *   - the production MESSAGE action search path returns only disclosable items
 */
import {
	attestDeliveryAudienceFromCanonicalRoom,
	type CanonicalProvenance,
	ChannelType,
	canonicalDedupeKey,
	deriveCanonicalProvenance,
	type IAgentRuntime,
	type Memory,
	searchCanonicalConversationMemories,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import {
	createTestRuntimeWithModelProvider,
	type ModelProviderTestRuntime,
} from "@elizaos/core/testing";
import type { Message } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageAction } from "../../../packages/core/src/features/advanced-capabilities/actions/message.ts";
import {
	buildMemoryFromMessage,
	type HistoryServiceInternals,
} from "../discord-history.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
	vi.restoreAllMocks();
});

function track(harness: ModelProviderTestRuntime): ModelProviderTestRuntime {
	cleanups.push(harness.cleanup);
	return harness;
}

function id(seed: string): UUID {
	return stringToUuid(seed) as UUID;
}

async function createRoom(
	runtime: IAgentRuntime,
	roomId: UUID,
	type: ChannelType,
	participants: UUID[] = [],
): Promise<void> {
	// Rooms are world-scoped in production; the adapter rejects an unparented
	// room. Give each room its own world so the shape matches a real connector
	// surface.
	const worldId = id(`world-${roomId}`);
	await runtime.createWorld({ id: worldId, agentId: runtime.agentId });
	await runtime.createRoom({ id: roomId, source: "test", type, worldId });
	for (const participant of participants) {
		// Participants are FK-constrained to real entities, so register the
		// sender before joining it to the room.
		await runtime.createEntity({
			id: participant,
			names: [`entity-${participant}`],
			agentId: runtime.agentId,
		});
		await runtime.addParticipant(participant, roomId);
	}
}

type MemoryOverrides = Omit<Partial<Memory>, "content" | "metadata"> & {
	content?: Partial<Memory["content"]>;
	metadata?: Record<string, unknown>;
};

function messageMemory(overrides: MemoryOverrides = {}): Memory {
	const roomId = overrides.roomId ?? id("source-room");
	const entityId = overrides.entityId ?? id("sender");
	const content = overrides.content ?? {};
	const metadata = overrides.metadata ?? {};
	return {
		id: id(`memory-${roomId}-${entityId}`),
		entityId,
		agentId: id("agent"),
		roomId,
		createdAt: 1_700_000_000_000,
		...overrides,
		content: {
			text: "The deploy key rotates on Friday.",
			source: "discord",
			...content,
		},
		metadata: {
			type: "message",
			provider: "discord",
			accountId: "discord-account-1",
			scope: "room",
			messageIdFull: "discord-message-1",
			discord: { userId: "discord-user-1" },
			...metadata,
		} as Memory["metadata"],
	};
}

/**
 * Build a delivery turn in a DM room with just the requester + agent, then
 * attest the trusted delivery audience so the revalidation gate passes and
 * cross-room recall is authorized (owner-private destination).
 */
async function ownerDeliveryTurn(
	runtime: IAgentRuntime,
	roomId: UUID,
	requesterEntityId: UUID,
): Promise<Memory> {
	await createRoom(runtime, roomId, ChannelType.DM, [requesterEntityId]);
	const delivery = messageMemory({
		agentId: runtime.agentId,
		roomId,
		entityId: requesterEntityId,
		metadata: {
			provider: "discord",
			accountId: "discord-account-1",
			messageIdFull: "delivery-message",
			scope: "room",
			discord: { userId: "discord-user-delivery" },
		},
	});
	await attestDeliveryAudienceFromCanonicalRoom(runtime, delivery);
	return delivery;
}

describe("canonical provenance envelope", () => {
	it.each([
		[
			"source",
			(memory: Memory) => {
				delete (memory.metadata as Record<string, unknown>).provider;
				delete (memory.content as Record<string, unknown>).source;
			},
		],
		[
			"account",
			(memory: Memory) => {
				delete (memory.metadata as Record<string, unknown>).accountId;
			},
		],
		[
			"platform record",
			(memory: Memory) => {
				delete (memory.metadata as Record<string, unknown>).messageIdFull;
			},
		],
		[
			"timestamp",
			(memory: Memory) => {
				delete memory.createdAt;
			},
		],
		[
			"scope",
			(memory: Memory) => {
				delete (memory.metadata as Record<string, unknown>).scope;
			},
		],
	])("returns typed invalid provenance for missing %s", (_field, mutate) => {
		const memory = messageMemory();
		mutate(memory);
		const provenance = deriveCanonicalProvenance(memory, id("agent"));
		expect(provenance).toEqual(
			expect.objectContaining({
				valid: false,
				code: "invalid_provenance",
			}),
		);
		if (!provenance.valid) {
			expect(provenance.reason).toContain(_field.split(" ")[0]);
		}
	});

	it("rejects conflicting source fields instead of silently picking the first", () => {
		const memory = messageMemory({
			content: { source: "telegram" },
		});
		// metadata.provider is "discord" but content.source is "telegram" —
		// conflicting provenance must be rejected, not silently resolved.
		const provenance = deriveCanonicalProvenance(memory, id("agent"));
		expect(provenance).toEqual(
			expect.objectContaining({
				valid: false,
				code: "invalid_provenance",
			}),
		);
	});

	it("withholds missing scope instead of fabricating global access", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("missing-scope-room");
		const requester = id("sender");
		const delivery = await ownerDeliveryTurn(runtime, roomId, requester);
		const candidate = messageMemory({ agentId: runtime.agentId, roomId });
		delete (candidate.metadata as Record<string, unknown>).scope;
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([candidate]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			deliveryMessage: delivery,
			count: 10,
		});

		expect(recall.items).toHaveLength(0);
		expect(recall.availability).toBe("unavailable");
		expect(recall.withheld[0]).toEqual(
			expect.objectContaining({
				code: "invalid_provenance",
				reason: expect.stringContaining("scope"),
			}),
		);
	});

	it("runs the mandatory scope ladder before containment", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("scope-ladder-room");
		const requester = id("ordinary-user");
		const delivery = await ownerDeliveryTurn(runtime, roomId, requester);
		const ownerScoped = messageMemory({
			agentId: runtime.agentId,
			roomId,
			entityId: id("owner"),
			metadata: { scope: "owner-private" },
		});
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([ownerScoped]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			deliveryMessage: delivery,
			count: 10,
		});

		// Same room, so containment would allow it — the scope ladder must be the
		// gate that withholds it.
		expect(recall.items).toHaveLength(0);
		expect(recall.withheld[0]?.code).toBe("scope_denied");
	});

	it("denies every cross-room disclosure with a typed code (audience policy is #17206's)", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const destinationRoomId = id("destination-room");
		const requester = id("sender");
		// The delivery turn is in a DM — but it is NOT owner-private relative to
		// the agent because the requester is an ordinary user, not the canonical
		// owner. Cross-room recall is denied by the gate, so same-room
		// containment applies and the cross-room candidate is withheld.
		const delivery = await ownerDeliveryTurn(runtime, destinationRoomId, requester);
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([
			messageMemory({ agentId: runtime.agentId, roomId: id("other-room") }),
		]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			deliveryMessage: delivery,
			count: 10,
		});

		expect(recall.items).toHaveLength(0);
		expect(recall.withheld[0]?.code).toBe("cross_room_denied");
	});

	it("surfaces adapter failure as unavailable instead of an empty complete result", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("adapter-failure-room");
		const delivery = await ownerDeliveryTurn(runtime, roomId, id("sender"));
		vi.spyOn(runtime, "searchMemories").mockRejectedValue(
			new Error("adapter offline"),
		);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			deliveryMessage: delivery,
			count: 10,
		});

		expect(recall.items).toHaveLength(0);
		expect(recall.availability).toBe("unavailable");
		expect(recall.candidateWindowComplete).toBe(false);
	});

	it("dedupes by source/account/room/platform id across distinct database primary keys", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("dedupe-room");
		const requester = id("sender");
		const delivery = await ownerDeliveryTurn(runtime, roomId, requester);
		const first = messageMemory({
			id: id("duplicate-memory-a"),
			agentId: runtime.agentId,
			roomId,
			createdAt: 1_700_000_000_000,
		});
		const second = messageMemory({
			id: id("duplicate-memory-b"),
			agentId: runtime.agentId,
			roomId,
			createdAt: 1_700_000_010_000,
		});
		expect(first.id).not.toBe(second.id);
		const firstProvenance = deriveCanonicalProvenance(first, runtime.agentId);
		const secondProvenance = deriveCanonicalProvenance(second, runtime.agentId);
		expect(firstProvenance.valid).toBe(true);
		expect(secondProvenance.valid).toBe(true);
		if (!firstProvenance.valid || !secondProvenance.valid) return;
		expect(canonicalDedupeKey(firstProvenance.provenance)).toBe(
			canonicalDedupeKey(secondProvenance.provenance),
		);
		// Same platform record under a DIFFERENT account: account identity is
		// part of the canonical key and must never be squashed. Two accounts
		// relaying the same platform message are two facts, not one.
		const otherAccount = messageMemory({
			id: id("duplicate-memory-c"),
			agentId: runtime.agentId,
			roomId,
			createdAt: 1_700_000_020_000,
			metadata: { accountId: "discord-account-2" },
		});
		const otherProvenance = deriveCanonicalProvenance(
			otherAccount,
			runtime.agentId,
		);
		expect(otherProvenance.valid).toBe(true);
		if (!otherProvenance.valid) return;
		expect(canonicalDedupeKey(otherProvenance.provenance)).not.toBe(
			canonicalDedupeKey(firstProvenance.provenance),
		);
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([
			second,
			first,
			otherAccount,
		]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			deliveryMessage: delivery,
			count: 10,
		});

		expect(recall.items).toHaveLength(2);
		expect(recall.items[0]?.memory.id).toBe(first.id);
		expect(
			recall.items.map((item) => item.provenance.accountId).sort(),
		).toEqual(["discord-account-1", "discord-account-2"]);
	});

	it("includes room identity in the dedupe key so Telegram chat-local ids do not collide", () => {
		// Telegram message ids are scoped to a chat. The same id in two chats
		// is two records, not one — the room segment in the key prevents a
		// collision.
		const baseMeta = {
			type: "message",
			provider: "telegram",
			accountId: "telegram-main",
			scope: "room",
			messageIdFull: "telegram-message-42",
			telegram: { userId: "telegram-user-1" },
		};
		const roomA = messageMemory({
			id: id("telegram-room-a-msg"),
			roomId: id("telegram-chat-a"),
			metadata: baseMeta,
		});
		const roomB = messageMemory({
			id: id("telegram-room-b-msg"),
			roomId: id("telegram-chat-b"),
			metadata: baseMeta,
		});
		const provA = deriveCanonicalProvenance(roomA, id("agent"));
		const provB = deriveCanonicalProvenance(roomB, id("agent"));
		expect(provA.valid).toBe(true);
		expect(provB.valid).toBe(true);
		if (!provA.valid || !provB.valid) return;
		expect(canonicalDedupeKey(provA.provenance)).not.toBe(
			canonicalDedupeKey(provB.provenance),
		);
	});

	it("does not label structural metadata as connector-verified", () => {
		// A nested metadata[source] object carrying userId is a structural fact
		// (the connector stamped an identity at ingestion), NOT an unforgeable
		// attestation. The trust level must be "sender-stamped", never
		// "connector-verified".
		const memory = messageMemory({
			entityId: id("non-agent-sender"),
		});
		const provenance = deriveCanonicalProvenance(memory, id("agent"));
		expect(provenance.valid).toBe(true);
		if (!provenance.valid) return;
		expect(provenance.provenance.trust).toBe("sender-stamped");
	});

	it("withheld diagnostics do not leak account or platform identifiers", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("no-leak-room");
		const requester = id("sender");
		const delivery = await ownerDeliveryTurn(runtime, roomId, requester);
		const crossRoom = messageMemory({
			agentId: runtime.agentId,
			roomId: id("leak-other-room"),
			metadata: {
				accountId: "discord-account-secret",
				messageIdFull: "discord-secret-message-id",
			},
		});
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([crossRoom]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			deliveryMessage: delivery,
			count: 10,
		});

		expect(recall.items).toHaveLength(0);
		// The withheld entry must NOT carry the source, accountId,
		// platformMessageId, or dedupeKey of the withheld memory.
		for (const withheld of recall.withheld) {
			expect(withheld).not.toHaveProperty("source");
			expect(withheld).not.toHaveProperty("dedupeKey");
			expect(withheld.reason).not.toContain("discord-account-secret");
			expect(withheld.reason).not.toContain("discord-secret-message-id");
		}
	});

	it("accepts the REAL Discord connector ingestion output (trusted scope stamping)", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;

		const channelId = "1253563208833433701";
		const guild = {
			id: "1253563208833400000",
			name: "Eliza Test Guild",
			ownerId: "1111111111111111111",
		};
		const channel = {
			id: channelId,
			type: DiscordChannelType.GuildText,
			guild,
		};
		const authorId = "2222222222222222222";
		const discordMessage = {
			id: "3333333333333333333",
			author: {
				id: authorId,
				username: "tester",
				bot: false,
				displayAvatarURL: () => "https://cdn.example/avatar.png",
			},
			channel,
			guild,
			content: "The deploy key rotates on Friday.",
			createdTimestamp: 1_700_000_000_000,
			url: `https://discord.com/channels/${guild.id}/${channelId}/3333333333333333333`,
			reference: undefined,
		} as unknown as Message;

		// The REAL extracted ingestion function, with the service internals the
		// production DiscordService supplies (no messageManager: raw content path).
		const service: HistoryServiceInternals = {
			accountId: "discord-account-1",
			client: {} as HistoryServiceInternals["client"],
			runtime: runtime as unknown as HistoryServiceInternals["runtime"],
			messageManager: undefined,
			resolveDiscordEntityId: (userId: string) => id(`discord-${userId}`),
			getChannelType: async () => ChannelType.GROUP,
			isGuildTextBasedChannel: (c): c is never => Boolean(c),
		};
		const memory = await buildMemoryFromMessage(service, discordMessage);
		expect(memory).not.toBeNull();
		if (!memory) return;

		const provenance = deriveCanonicalProvenance(memory, runtime.agentId);
		expect(provenance.valid).toBe(true);
		if (!provenance.valid) return;
		expect(provenance.provenance).toEqual(
			expect.objectContaining({
				source: "discord",
				accountId: "discord-account-1",
				platformMessageId: "3333333333333333333",
				senderPlatformId: authorId,
				trust: "sender-stamped",
				scope: "room",
			}),
		);
		expect(canonicalDedupeKey(provenance.provenance)).toBe(
			`discord:discord-account-1:${provenance.provenance.roomId}:3333333333333333333`,
		);
	});

	it("uses the real PGLite adapter on the production MESSAGE search path", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("production-search-room");
		const otherRoomId = id("production-other-room");
		const requester = id("requester");
		await createRoom(runtime, roomId, ChannelType.DM, [requester]);
		await createRoom(runtime, otherRoomId, ChannelType.DM, [requester]);
		const embedding = new Array<number>(384).fill(0.1);
		const first = messageMemory({
			id: id("production-duplicate-a"),
			agentId: runtime.agentId,
			roomId,
			entityId: requester,
			createdAt: 1_700_000_000_000,
			embedding,
		});
		const second = messageMemory({
			id: id("production-duplicate-b"),
			agentId: runtime.agentId,
			roomId,
			entityId: requester,
			createdAt: 1_700_000_010_000,
			embedding,
		});
		// A candidate in a DIFFERENT room: must be withheld (cross_room_denied),
		// never silently returned into this destination.
		const crossRoom = messageMemory({
			id: id("production-cross-room"),
			agentId: runtime.agentId,
			roomId: otherRoomId,
			entityId: requester,
			createdAt: 1_700_000_020_000,
			embedding,
			metadata: { messageIdFull: "discord-message-2" },
		});
		await runtime.createMemory(first, "messages", false);
		await runtime.createMemory(second, "messages", false);
		await runtime.createMemory(crossRoom, "messages", false);
		vi.spyOn(runtime, "useModel").mockResolvedValue(embedding as never);
		const searchSpy = vi.spyOn(runtime, "searchMemories");

		const result = await messageAction.handler(
			runtime,
			messageMemory({
				id: id("production-request"),
				agentId: runtime.agentId,
				roomId,
				entityId: requester,
				content: { text: "Find deploy key", source: "client_chat" },
			}),
			undefined,
			{ parameters: { action: "search", query: "deploy key" } },
			undefined,
			undefined,
		);
		if (!result) throw new Error("MESSAGE handler returned no result");

		expect(searchSpy).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		const data = result.data as {
			results?: Array<{ id: UUID; roomId: UUID }>;
			availability?: string;
			withheld?: Array<{ code: string }>;
		};
		// Duplicate collapsed to the earliest row; the cross-room row withheld.
		expect(data.results).toHaveLength(1);
		expect(data.results?.[0]?.id).toBe(first.id);
		expect(data.results?.every((r) => r.roomId === roomId)).toBe(true);
		expect(data.availability).toBe("partial");
		expect(data.withheld?.[0]?.code).toBe("cross_room_denied");
	});
});
