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
} from "@elizaos/testing/runtime";
import type { Message } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageAction } from "../../plugin-assistant/src/features/advanced-capabilities/actions/message.ts";
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
		const delivery = await ownerDeliveryTurn(
			runtime,
			destinationRoomId,
			requester,
		);
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

	it("requires fresh delivery evidence bound to the recalling runtime", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const requester = id("delivery-evidence-requester");

		const missingRoomId = id("missing-delivery-evidence-room");
		await createRoom(runtime, missingRoomId, ChannelType.DM, [requester]);
		const missingDelivery = messageMemory({
			agentId: runtime.agentId,
			roomId: missingRoomId,
			entityId: requester,
		});
		const searchSpy = vi.spyOn(runtime, "searchMemories");
		await expect(
			searchCanonicalConversationMemories({
				runtime,
				embedding: [0.1, 0.2],
				deliveryMessage: missingDelivery,
				count: 10,
			}),
		).resolves.toMatchObject({
			items: [],
			availability: "unavailable",
			candidateWindowComplete: false,
		});

		const expiredDelivery = await ownerDeliveryTurn(
			runtime,
			id("expired-delivery-evidence-room"),
			requester,
		);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, expiredDelivery, {
			nowMs: Date.now() - 1_000,
			ttlMs: 1,
		});
		await expect(
			searchCanonicalConversationMemories({
				runtime,
				embedding: [0.1, 0.2],
				deliveryMessage: expiredDelivery,
				count: 10,
			}),
		).resolves.toMatchObject({
			items: [],
			availability: "unavailable",
			candidateWindowComplete: false,
		});
		expect(searchSpy).not.toHaveBeenCalled();

		const otherHarness = track(await createTestRuntimeWithModelProvider({}));
		const otherSearchSpy = vi.spyOn(otherHarness.runtime, "searchMemories");
		const runtimeBoundDelivery = await ownerDeliveryTurn(
			runtime,
			id("wrong-runtime-delivery-evidence-room"),
			requester,
		);
		await expect(
			searchCanonicalConversationMemories({
				runtime: otherHarness.runtime,
				embedding: [0.1, 0.2],
				deliveryMessage: runtimeBoundDelivery,
				count: 10,
			}),
		).resolves.toMatchObject({
			items: [],
			availability: "unavailable",
			candidateWindowComplete: false,
		});
		expect(otherSearchSpy).not.toHaveBeenCalled();
	});

	it("ignores a spoofed caller agent id and caps results to count", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("spoofed-agent-room");
		const requester = id("spoofed-agent-requester");
		const delivery = await ownerDeliveryTurn(runtime, roomId, requester);
		const candidates = [0, 1, 2, 3].map((index) =>
			messageMemory({
				id: id(`spoofed-agent-candidate-${index}`),
				agentId: runtime.agentId,
				roomId,
				entityId: requester,
				metadata: {
					scope: index === 0 ? "agent-private" : "room",
					messageIdFull: `discord-message-${index}`,
				},
			}),
		);
		vi.spyOn(runtime, "searchMemories").mockResolvedValue(candidates);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			// This formerly minted the AGENT tier because it matched requester.
			agentId: requester,
			deliveryMessage: delivery,
			count: 2,
		});

		expect(recall.withheld[0]?.code).toBe("scope_denied");
		expect(recall.items).toHaveLength(2);
		expect(recall.items.every((item) => item.provenance.scope === "room")).toBe(
			true,
		);
	});

	it("caps a refilled window to the best-ranked items, not the oldest", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("ranked-refill-room");
		const requester = id("ranked-refill-requester");
		const delivery = await ownerDeliveryTurn(runtime, roomId, requester);
		const candidate = (
			name: string,
			createdAt: number,
			scope: string,
		): Memory =>
			messageMemory({
				id: id(`ranked-refill-${name}`),
				agentId: runtime.agentId,
				roomId,
				entityId: requester,
				createdAt,
				metadata: { scope, messageIdFull: `discord-message-${name}` },
			});
		// Adapter relevance order. The best match is the newest row, and the
		// denied row forces a second, wider round that pulls in older and
		// less relevant rows.
		const ranked = [
			candidate("best", 1_700_000_030_000, "room"),
			candidate("denied", 1_700_000_020_000, "agent-private"),
			candidate("second", 1_700_000_010_000, "room"),
			candidate("third", 1_700_000_000_000, "room"),
		];
		const searchSpy = vi
			.spyOn(runtime, "searchMemories")
			.mockImplementation(async (params) => ranked.slice(0, params.count));

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			deliveryMessage: delivery,
			count: 2,
		});

		expect(searchSpy).toHaveBeenCalledTimes(2);
		// The two best-ranked eligible rows, still in transcript order.
		expect(
			recall.items.map((item) => item.provenance.platformMessageId),
		).toEqual(["discord-message-second", "discord-message-best"]);
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
			content: { source: "telegram" },
			metadata: baseMeta,
		});
		const roomB = messageMemory({
			id: id("telegram-room-b-msg"),
			roomId: id("telegram-chat-b"),
			content: { source: "telegram" },
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
			isOwnerAliasedDiscordUser: () => false,
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
		// A candidate in a DIFFERENT room: the room-constrained adapter query must
		// exclude it before canonical evaluation.
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

		const request = messageMemory({
			id: id("production-request"),
			agentId: runtime.agentId,
			roomId,
			entityId: requester,
			content: { text: "Find deploy key", source: "client_chat" },
		});
		await attestDeliveryAudienceFromCanonicalRoom(runtime, request);
		const result = await messageAction.handler(
			runtime,
			request,
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
		// Duplicate collapsed to the earliest row; the cross-room row never
		// entered the candidate window.
		expect(data.results).toHaveLength(1);
		expect(data.results?.[0]?.id).toBe(first.id);
		expect(data.results?.every((r) => r.roomId === roomId)).toBe(true);
		expect(data.availability).toBe("complete");
		expect(data.withheld).toEqual([]);
	});

	it("returns the closest match on the MESSAGE search path when a limit is set", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("limited-search-room");
		const requester = id("limited-search-requester");
		await createRoom(runtime, roomId, ChannelType.DM, [requester]);
		const queryEmbedding = new Array<number>(384).fill(0);
		queryEmbedding[0] = 1;
		// Cosine similarity 0.8: above the search threshold, but a weaker match.
		const weakerEmbedding = new Array<number>(384).fill(0);
		weakerEmbedding[0] = 0.8;
		weakerEmbedding[1] = 0.6;
		const stored = (
			name: string,
			createdAt: number,
			embedding: number[],
		): Memory =>
			messageMemory({
				id: id(`limited-search-${name}`),
				agentId: runtime.agentId,
				roomId,
				entityId: requester,
				createdAt,
				embedding,
				content: { text: `Deploy note ${name}.` },
				metadata: { messageIdFull: `discord-message-${name}` },
			});
		const older = stored("older", 1_700_000_000_000, weakerEmbedding);
		const old = stored("old", 1_700_000_010_000, weakerEmbedding);
		const closest = stored("closest", 1_700_000_020_000, queryEmbedding);
		for (const memory of [older, old, closest]) {
			await runtime.createMemory(memory, "messages", false);
		}
		vi.spyOn(runtime, "useModel").mockResolvedValue(queryEmbedding as never);

		const request = messageMemory({
			id: id("limited-search-request"),
			agentId: runtime.agentId,
			roomId,
			entityId: requester,
			content: { text: "Find the deploy note", source: "client_chat" },
		});
		await attestDeliveryAudienceFromCanonicalRoom(runtime, request);
		const result = await messageAction.handler(
			runtime,
			request,
			undefined,
			{ parameters: { action: "search", query: "deploy note", limit: 1 } },
			undefined,
			undefined,
		);
		if (!result) throw new Error("MESSAGE handler returned no result");

		expect(result.success).toBe(true);
		const data = result.data as { results?: Array<{ text: string }> };
		expect(data.results?.map((r) => r.text)).toEqual(["Deploy note closest."]);
	});

	it("keeps the widened window's ranking when a refill re-ranks earlier rows", async () => {
		const harness = track(await createTestRuntimeWithModelProvider({}));
		const { runtime } = harness;
		const roomId = id("reranked-refill-room");
		const requester = id("reranked-refill-requester");
		await createRoom(runtime, roomId, ChannelType.DM, [requester]);
		const queryEmbedding = new Array<number>(384).fill(0);
		queryEmbedding[0] = 1;
		const similarTo = (cosine: number): number[] => {
			const embedding = new Array<number>(384).fill(0);
			embedding[0] = cosine;
			embedding[1] = Math.sqrt(1 - cosine * cosine);
			return embedding;
		};
		const stored = (
			name: string,
			createdAt: number,
			cosine: number,
			text: string,
		): Memory =>
			messageMemory({
				id: id(`reranked-refill-${name}`),
				agentId: runtime.agentId,
				roomId,
				entityId: requester,
				createdAt,
				embedding: similarTo(cosine),
				content: { text },
				metadata: { messageIdFull: `discord-message-${name}` },
			});
		// Vector order: the closest vector is a row without the query terms,
		// then ten rows that provenance validation withholds (no connector
		// account), then the only row that matches the query text. limit 1
		// asks for 11 rows, so the first window holds one eligible row and a
		// second, wider round brings in the text match, which the adapter's
		// BM25 rerank puts first.
		const nearest = stored("nearest", 1_700_000_020_000, 0.99, "Ship notice.");
		const withheld = Array.from({ length: 10 }, (_, index) => {
			const memory = stored(
				`withheld-${index}`,
				1_700_000_010_000 + index,
				0.95 - index * 0.02,
				"Lunch plans.",
			);
			delete (memory.metadata as Record<string, unknown>).accountId;
			return memory;
		});
		const textMatch = stored("match", 1_700_000_000_000, 0.65, "Deploy note.");
		for (const memory of [nearest, ...withheld, textMatch]) {
			await runtime.createMemory(memory, "messages", false);
		}
		vi.spyOn(runtime, "useModel").mockResolvedValue(queryEmbedding as never);
		const searchSpy = vi.spyOn(runtime, "searchMemories");

		const request = messageMemory({
			id: id("reranked-refill-request"),
			agentId: runtime.agentId,
			roomId,
			entityId: requester,
			content: { text: "Find the deploy note", source: "client_chat" },
		});
		await attestDeliveryAudienceFromCanonicalRoom(runtime, request);
		const result = await messageAction.handler(
			runtime,
			request,
			undefined,
			{ parameters: { action: "search", query: "deploy note", limit: 1 } },
			undefined,
			undefined,
		);
		if (!result) throw new Error("MESSAGE handler returned no result");

		expect(searchSpy).toHaveBeenCalledTimes(2);
		expect(result.success).toBe(true);
		const data = result.data as { results?: Array<{ text: string }> };
		expect(data.results?.map((r) => r.text)).toEqual(["Deploy note."]);
	});
});
