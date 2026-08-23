/**
 * Covers createNativeRelationshipsGraphService end to end against a fake
 * runtime: person summary assembly from entities and contacts, query
 * filtering/pagination, explicit and conversation-derived graph edges,
 * relevance scoping, identity-cluster unions, merge mutation errors plus
 * cache invalidation, person detail assembly, and the cluster-aware memory
 * fan-out helpers.
 */
import { describe, expect, it } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	Metadata,
	Relationship,
	UUID,
} from "../types/index";
import {
	createNativeRelationshipsGraphService,
	getMemoriesForCluster,
	searchMemoriesForCluster,
} from "./relationships-graph-builder";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ALICE = "22222222-2222-4222-8222-222222222222" as UUID;
const BOB = "33333333-3333-4333-8333-333333333333" as UUID;
const CAROL = "44444444-4444-4444-8444-444444444444" as UUID;
const DAVE = "55555555-5555-4555-8555-555555555555" as UUID;
const ALICE_ALT = "66666666-6666-4666-8666-666666666666" as UUID;
const UNKNOWN = "99999999-9999-4999-8999-999999999999" as UUID;
const ROOM_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const ROOM_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const WORLD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

type EntityStub = {
	id: UUID;
	names: string[];
	metadata?: Metadata;
};

type MemoryQuery = {
	tableName: string;
	roomId?: UUID;
	entityId?: UUID;
};

type FakeRuntimeOptions = {
	entityStubs?: Record<string, EntityStub | null>;
	relationships?: Relationship[];
	factsByEntity?: Record<string, Memory[]>;
	messagesByRoom?: Record<string, Memory[]>;
	memoriesByEntity?: Record<string, Memory[]>;
	searchResultsByEntity?: Record<string, Memory[]>;
	roomsForParticipants?: UUID[];
	rooms?: Array<{ id: UUID; name: string; type?: string }>;
	worlds?: number;
	relationshipsService?: unknown;
	onGetMemories?: (query: MemoryQuery) => void;
	onSearchMemories?: (query: MemoryQuery & { embedding?: number[] }) => void;
};

function makeMemory(
	partial: Pick<Memory, "id" | "entityId"> & {
		text: string;
		createdAt?: number;
		roomId?: UUID;
	},
): Memory {
	return {
		id: partial.id as UUID,
		entityId: partial.entityId,
		roomId: partial.roomId ?? ROOM_1,
		agentId: AGENT_ID,
		createdAt: partial.createdAt ?? 0,
		content: { text: partial.text },
	} as Memory;
}

function makeRelationship(partial: {
	id: UUID;
	sourceEntityId: UUID;
	targetEntityId: UUID;
	tags?: string[];
	metadata?: Metadata;
}): Relationship {
	return {
		id: partial.id,
		sourceEntityId: partial.sourceEntityId,
		targetEntityId: partial.targetEntityId,
		agentId: AGENT_ID,
		tags: partial.tags ?? [],
		metadata: partial.metadata,
	};
}

function makeRuntime(options: FakeRuntimeOptions = {}): IAgentRuntime {
	const entityStubs = options.entityStubs ?? {};
	return {
		agentId: AGENT_ID,
		async getAllWorlds() {
			return Array.from({ length: options.worlds ?? 0 }, () => ({
				id: WORLD_ID,
				name: "World",
			}));
		},
		async getRoomsByWorlds() {
			return options.rooms ?? [];
		},
		async getRoomsByIds(roomIds: UUID[]) {
			return (options.rooms ?? []).filter((room) => roomIds.includes(room.id));
		},
		async getRoomsForParticipants() {
			return options.roomsForParticipants ?? [];
		},
		async getEntitiesForRoom(roomId: UUID) {
			if (roomId === ROOM_1) {
				return [entityStubs[ALICE], entityStubs[BOB]].filter(Boolean);
			}
			if (roomId === ROOM_2) {
				return [entityStubs[CAROL]].filter(Boolean);
			}
			return [];
		},
		async getRelationships() {
			return options.relationships ?? [];
		},
		async getEntityById(entityId: UUID) {
			return entityStubs[entityId] ?? null;
		},
		async getMemories(query: MemoryQuery) {
			options.onGetMemories?.(query);
			if (query.tableName === "facts") {
				return (options.factsByEntity?.[query.entityId ?? ""] ?? []) as never;
			}
			if (query.tableName === "messages") {
				if (query.roomId) {
					return (options.messagesByRoom?.[query.roomId] ?? []) as never;
				}
				return (options.memoriesByEntity?.[query.entityId ?? ""] ??
					[]) as never;
			}
			return [] as never;
		},
		async searchMemories(query: MemoryQuery & { embedding?: number[] }) {
			options.onSearchMemories?.(query);
			return (options.searchResultsByEntity?.[query.entityId ?? ""] ??
				[]) as never;
		},
		getService() {
			return options.relationshipsService ?? null;
		},
	} as unknown as IAgentRuntime;
}

describe("createNativeRelationshipsGraphService", () => {
	it("builds a person summary from entity platform identities and contact fields", async () => {
		const runtime = makeRuntime({
			entityStubs: {
				[ALICE]: {
					id: ALICE,
					names: ["Alice Chen"],
					metadata: {
						platformIdentities: [
							{ platform: "Discord", handle: "@alicechen" },
							{ platform: "Email", handle: "Alice@Example.com" },
						],
					},
				},
			},
		});
		const service = createNativeRelationshipsGraphService(runtime, {
			async searchContacts() {
				return [
					{
						entityId: ALICE,
						categories: ["friend"],
						tags: ["vip"],
						preferences: { preferredCommunicationChannel: "email" },
						customFields: {
							displayName: "Alice C.",
							phone: "+1 555 0100",
							website: "https://alice.example.com/",
						},
						lastModified: "2026-08-01T10:00:00.000Z",
					},
				];
			},
			async getContact(entityId: UUID) {
				return entityId === ALICE
					? {
							entityId: ALICE,
							categories: ["friend"],
							tags: ["vip"],
							preferences: { preferredCommunicationChannel: "email" },
							customFields: {
								displayName: "Alice C.",
								phone: "+1 555 0100",
								website: "https://alice.example.com/",
							},
							lastModified: "2026-08-01T10:00:00.000Z",
						}
					: null;
			},
			async getCandidateMerges() {
				return [
					{
						id: "candidate-1",
						entityA: ALICE,
						entityB: BOB,
						confidence: 0.9,
						evidence: { notes: "same person" },
						status: "pending",
						proposedAt: "2026-08-01T00:00:00.000Z",
					},
				];
			},
		});

		const snapshot = await service.getGraphSnapshot();

		expect(snapshot.people).toHaveLength(1);
		const alice = snapshot.people[0];
		expect(alice?.primaryEntityId).toBe(ALICE);
		expect(alice?.memberEntityIds).toEqual([ALICE]);
		expect(alice?.displayName).toBe("Alice C.");
		expect(alice?.aliases).toEqual(["Alice Chen"]);
		expect(alice?.emails).toEqual(["Alice@Example.com"]);
		expect(alice?.phones).toEqual(["+1 555 0100"]);
		expect(alice?.websites).toEqual(["https://alice.example.com/"]);
		expect(alice?.platforms).toEqual(["discord", "email"]);
		expect(alice?.preferredCommunicationChannel).toBe("email");
		expect(alice?.categories).toEqual(["friend"]);
		expect(alice?.tags).toEqual(["vip"]);
		expect(alice?.isOwner).toBe(false);
		expect(alice?.lastInteractionAt).toBe("2026-08-01T10:00:00.000Z");
		expect(alice?.factCount).toBe(0);
		expect(alice?.relationshipCount).toBe(0);
		expect(alice?.identities).toHaveLength(1);
		expect(alice?.identities[0]?.names).toEqual(["Alice Chen"]);
		expect(alice?.identities[0]?.handles).toEqual([
			{
				entityId: ALICE,
				platform: "discord",
				handle: "@alicechen",
				status: null,
				verified: null,
			},
		]);
		expect(snapshot.candidateMerges).toHaveLength(1);
		expect(snapshot.stats).toEqual({
			totalPeople: 1,
			totalRelationships: 0,
			totalIdentities: 1,
		});
	});

	it("flags the owner summary and overrides its display name with the configured owner name", async () => {
		const runtime = makeRuntime({
			entityStubs: {
				[ALICE]: { id: ALICE, names: ["Alice Chen"] },
			},
		});
		const service = createNativeRelationshipsGraphService(
			runtime,
			{
				async searchContacts() {
					return [{ entityId: ALICE }];
				},
				async getCandidateMerges() {
					return [];
				},
			},
			{
				resolveOwnerEntityId: async () => ALICE,
				fetchConfiguredOwnerName: async () => "Operator",
			},
		);

		const snapshot = await service.getGraphSnapshot();

		expect(snapshot.people).toHaveLength(1);
		const owner = snapshot.people[0];
		expect(owner?.isOwner).toBe(true);
		expect(owner?.displayName).toBe("Operator");
		expect(
			owner?.profiles.some(
				(profile) => profile.canonical === true && profile.userId === ALICE,
			),
		).toBe(true);

		const byOwnerKeyword = await service.getGraphSnapshot({
			search: "owner",
		});
		expect(byOwnerKeyword.people).toHaveLength(1);
	});

	it("filters snapshots by platform and case-insensitive search and paginates people", async () => {
		const runtime = makeRuntime({
			entityStubs: {
				[ALICE]: {
					id: ALICE,
					names: ["Alice Chen"],
					metadata: {
						platformIdentities: [{ platform: "Discord", handle: "@alice" }],
					},
				},
				[BOB]: {
					id: BOB,
					names: ["Bob"],
					metadata: {
						platformIdentities: [{ platform: "Telegram", handle: "@bob" }],
					},
				},
			},
			relationships: [
				makeRelationship({
					id: "rel-1" as UUID,
					sourceEntityId: ALICE,
					targetEntityId: BOB,
					metadata: { relationshipType: "mentor" },
				}),
			],
		});
		const service = createNativeRelationshipsGraphService(runtime, {
			async searchContacts() {
				return [{ entityId: ALICE }, { entityId: BOB }];
			},
			async getCandidateMerges() {
				return [];
			},
		});

		const byPlatform = await service.getGraphSnapshot({ platform: "discord" });
		expect(byPlatform.people.map((person) => person.primaryEntityId)).toEqual([
			ALICE,
		]);
		expect(byPlatform.relationships).toEqual([]);
		expect(byPlatform.stats.totalRelationships).toBe(0);
		expect(byPlatform.people[0]?.relationshipCount).toBe(0);

		const bySearch = await service.getGraphSnapshot({ search: "BOB" });
		expect(bySearch.people.map((person) => person.primaryEntityId)).toEqual([
			BOB,
		]);

		const limited = await service.getGraphSnapshot({ limit: 1 });
		expect(limited.people.map((person) => person.primaryEntityId)).toEqual([
			ALICE,
		]);
		expect(limited.people[0]?.relationshipCount).toBe(1);
		expect(limited.relationships).toEqual([]);
		expect(limited.stats.totalPeople).toBe(2);
		expect(limited.stats.totalRelationships).toBe(1);

		const negativeOffset = await service.getGraphSnapshot({
			offset: -5,
			limit: 1,
		});
		expect(
			negativeOffset.people.map((person) => person.primaryEntityId),
		).toEqual([ALICE]);

		const secondPage = await service.getGraphSnapshot({ offset: 1, limit: 1 });
		expect(secondPage.people.map((person) => person.primaryEntityId)).toEqual([
			BOB,
		]);

		const zeroLimit = await service.getGraphSnapshot({ limit: 0 });
		expect(zeroLimit.people).toHaveLength(2);
	});

	it("derives one weighted edge per person pair from explicit relationships with dominant sentiment", async () => {
		const runtime = makeRuntime({
			entityStubs: {
				[ALICE]: { id: ALICE, names: ["Alice Chen"] },
				[BOB]: { id: BOB, names: ["Bob"] },
			},
			relationships: [
				makeRelationship({
					id: "rel-1" as UUID,
					sourceEntityId: ALICE,
					targetEntityId: BOB,
					metadata: {
						relationshipType: "mentor",
						sentiment: "positive",
						strength: 80,
						interactionCount: 3,
						lastInteractionAt: "2026-08-02T00:00:00.000Z",
					},
				}),
				makeRelationship({
					id: "rel-2" as UUID,
					sourceEntityId: BOB,
					targetEntityId: ALICE,
					tags: ["collaborator"],
				}),
				makeRelationship({
					id: "rel-3" as UUID,
					sourceEntityId: ALICE,
					targetEntityId: BOB,
					metadata: {
						relationshipType: "peer",
						sentiment: "positive",
						strength: 250,
						interactionCount: 2,
						lastInteractionAt: "2026-08-05T00:00:00.000Z",
					},
				}),
				makeRelationship({
					id: "rel-4" as UUID,
					sourceEntityId: ALICE,
					targetEntityId: BOB,
					tags: ["identity_link"],
				}),
			],
		});
		const service = createNativeRelationshipsGraphService(runtime, {
			async searchContacts() {
				return [{ entityId: ALICE }, { entityId: BOB }];
			},
			async getCandidateMerges() {
				return [];
			},
		});

		const snapshot = await service.getGraphSnapshot();

		expect(snapshot.relationships).toHaveLength(1);
		const edge = snapshot.relationships[0];
		expect(edge?.id).toBe(`${ALICE}:${BOB}`);
		expect(edge?.sourcePersonId).toBe(ALICE);
		expect(edge?.targetPersonId).toBe(BOB);
		expect(edge?.sourcePersonName).toBe("Alice Chen");
		expect(edge?.targetPersonName).toBe("Bob");
		expect(edge?.relationshipTypes).toEqual(["mentor", "collaborator", "peer"]);
		expect(edge?.sentiment).toBe("positive");
		expect(edge?.strength).toBeCloseTo((0.8 + 0.5 + 1) / 3, 10);
		expect(edge?.interactionCount).toBe(6);
		expect(edge?.lastInteractionAt).toBe("2026-08-05T00:00:00.000Z");
		expect(edge?.rawRelationshipIds).toEqual(["rel-1", "rel-2", "rel-3"]);

		for (const person of snapshot.people) {
			expect(person.relationshipCount).toBe(1);
			expect(person.lastInteractionAt).toBe("2026-08-05T00:00:00.000Z");
		}
	});

	it("unions entities sharing an identity handle into one cluster and skips intra-cluster relationships", async () => {
		const runtime = makeRuntime({
			entityStubs: {
				[CAROL]: {
					id: CAROL,
					names: ["Carol"],
					metadata: {
						platformIdentities: [
							{ platform: "Twitter", handle: "@SameHandle" },
						],
					},
				},
				[DAVE]: {
					id: DAVE,
					names: [],
					metadata: {
						platformIdentities: [
							{ platform: "twitter", handle: "@samehandle" },
						],
					},
				},
			},
			relationships: [
				makeRelationship({
					id: "rel-twin" as UUID,
					sourceEntityId: CAROL,
					targetEntityId: DAVE,
					metadata: { relationshipType: "twin" },
				}),
			],
		});
		const service = createNativeRelationshipsGraphService(runtime, {
			async searchContacts() {
				return [{ entityId: CAROL }, { entityId: DAVE }];
			},
			async getCandidateMerges() {
				return [];
			},
		});

		const snapshot = await service.getGraphSnapshot();

		expect(snapshot.people).toHaveLength(1);
		const cluster = snapshot.people[0];
		expect(cluster?.primaryEntityId).toBe(CAROL);
		expect(cluster?.memberEntityIds).toEqual([CAROL, DAVE]);
		expect(cluster?.displayName).toBe("Carol");
		expect(cluster?.relationshipCount).toBe(0);
		expect(snapshot.relationships).toEqual([]);
		expect(snapshot.stats.totalPeople).toBe(1);
		expect(snapshot.stats.totalRelationships).toBe(0);
	});

	it("merges conversation adjacency edges into explicit edges and drops non-connected posters under the relevant scope", async () => {
		const aug = (seconds: number) =>
			Date.parse(`2026-08-03T00:00:0${seconds}.000Z`);
		const runtime = makeRuntime({
			worlds: 1,
			rooms: [
				{ id: ROOM_1, name: "Group Room", type: "group" },
				{ id: ROOM_2, name: "Solo Room", type: "group" },
			],
			entityStubs: {
				[ALICE]: { id: ALICE, names: ["Alice"] },
				[BOB]: { id: BOB, names: ["Bob"] },
				[CAROL]: { id: CAROL, names: ["Carol"] },
			},
			relationships: [
				makeRelationship({
					id: "rel-1" as UUID,
					sourceEntityId: ALICE,
					targetEntityId: BOB,
					metadata: {
						relationshipType: "mentor",
						sentiment: "positive",
						strength: 80,
						interactionCount: 3,
						lastInteractionAt: "2026-08-02T00:00:00.000Z",
					},
				}),
			],
			messagesByRoom: {
				[ROOM_1]: [
					makeMemory({
						id: "m1",
						entityId: ALICE,
						text: "hi",
						createdAt: aug(1),
					}),
					makeMemory({
						id: "m2",
						entityId: BOB,
						text: "hey",
						createdAt: aug(2),
					}),
					makeMemory({
						id: "m3",
						entityId: ALICE,
						text: "again",
						createdAt: aug(3),
					}),
				],
				[ROOM_2]: [
					makeMemory({
						id: "m4",
						entityId: CAROL,
						text: "solo",
						createdAt: aug(4),
						roomId: ROOM_2,
					}),
				],
			},
		});
		const service = createNativeRelationshipsGraphService(runtime, {
			async getCandidateMerges() {
				return [];
			},
		});

		const all = await service.getGraphSnapshot();
		expect(all.people.map((person) => person.primaryEntityId)).toHaveLength(3);

		const relevant = await service.getGraphSnapshot({ scope: "relevant" });
		expect(relevant.people.map((person) => person.primaryEntityId)).toEqual([
			ALICE,
			BOB,
		]);
		expect(relevant.stats.totalPeople).toBe(2);
		expect(relevant.relationships).toHaveLength(1);

		const edge = relevant.relationships[0];
		expect(edge?.sourcePersonId).toBe(ALICE);
		expect(edge?.targetPersonId).toBe(BOB);
		expect(edge?.relationshipTypes).toEqual([
			"mentor",
			"conversation",
			"direct_exchange",
		]);
		expect(edge?.interactionCount).toBe(5);
		expect(edge?.rawRelationshipIds).toContain("rel-1");
		expect(edge?.rawRelationshipIds).toContain(`room:${ROOM_1}`);
		expect(edge?.lastInteractionAt).toBe("2026-08-03T00:00:03.000Z");
		expect(edge?.strength).toBeGreaterThan(0.5);
		expect(edge?.strength).toBeLessThanOrEqual(1);
	});

	it("throws typed errors when merge mutations are unsupported and invalidates the cache on supported ones", async () => {
		const bare = createNativeRelationshipsGraphService(makeRuntime(), {});
		await expect(bare.acceptMerge("c1" as UUID)).rejects.toThrow(
			"RelationshipsService does not support merge acceptance",
		);
		await expect(bare.rejectMerge("c1" as UUID)).rejects.toThrow(
			"RelationshipsService does not support merge rejection",
		);
		await expect(bare.proposeMerge(ALICE, BOB, {})).rejects.toThrow(
			"RelationshipsService does not support merge proposals",
		);

		let worldsCalls = 0;
		const proposed: Array<[UUID, UUID, unknown]> = [];
		let accepted: string | null = null;
		let rejected: string | null = null;
		const countingRuntime: IAgentRuntime = new Proxy(makeRuntime(), {
			get(target, property, receiver) {
				if (property === "getAllWorlds") {
					return async () => {
						worldsCalls += 1;
						return (
							target as IAgentRuntime & { getAllWorlds: () => Promise<unknown> }
						).getAllWorlds();
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const service = createNativeRelationshipsGraphService(countingRuntime, {
			proposeMerge: async (entityA: UUID, entityB: UUID, evidence: unknown) => {
				proposed.push([entityA, entityB, evidence]);
				return "candidate-7" as UUID;
			},
			acceptMerge: async (candidateId: UUID) => {
				accepted = candidateId;
			},
			rejectMerge: async (candidateId: UUID) => {
				rejected = candidateId;
			},
		});

		await service.getGraphSnapshot();
		expect(worldsCalls).toBe(1);

		const evidence = { notes: "same human", handle: "@alice" };
		await expect(service.proposeMerge(ALICE, BOB, evidence)).resolves.toBe(
			"candidate-7",
		);
		expect(proposed).toEqual([[ALICE, BOB, evidence]]);

		await service.getGraphSnapshot();
		expect(worldsCalls).toBe(2);

		await service.acceptMerge("candidate-8" as UUID);
		expect(accepted).toBe("candidate-8");
		await service.getGraphSnapshot();
		expect(worldsCalls).toBe(3);

		await service.rejectMerge("candidate-9" as UUID);
		expect(rejected).toBe("candidate-9");
		await service.getGraphSnapshot();
		expect(worldsCalls).toBe(4);
	});

	it("returns null for a person outside every cluster", async () => {
		const service = createNativeRelationshipsGraphService(makeRuntime(), {
			async searchContacts() {
				return [];
			},
		});
		await expect(service.getPersonDetail(UNKNOWN)).resolves.toBeNull();
	});

	it("assembles member-scoped person detail with identity edges, contact facts, memories, and conversations", async () => {
		const linkTime = Date.parse("2026-08-04T00:00:00.000Z");
		const runtime = makeRuntime({
			entityStubs: {
				[ALICE]: { id: ALICE, names: ["Alice"] },
				[ALICE_ALT]: { id: ALICE_ALT, names: [] },
			},
			relationships: [
				makeRelationship({
					id: "link-1" as UUID,
					sourceEntityId: ALICE,
					targetEntityId: ALICE_ALT,
					tags: ["identity_link"],
					metadata: { status: "confirmed" },
				}),
			],
			memoriesByEntity: {
				[ALICE]: [
					makeMemory({
						id: "pm-alice",
						entityId: ALICE,
						text: "hello there",
						createdAt: linkTime,
					}),
				],
				[ALICE_ALT]: [
					makeMemory({
						id: "pm-alt",
						entityId: ALICE_ALT,
						text: "alt speaks",
						createdAt: linkTime - 1000,
					}),
				],
			},
			messagesByRoom: {
				[ROOM_1]: [
					makeMemory({
						id: "pm-alt",
						entityId: ALICE_ALT,
						text: "alt speaks",
						createdAt: linkTime - 1000,
					}),
					makeMemory({
						id: "pm-alice",
						entityId: ALICE,
						text: "hello there",
						createdAt: linkTime,
					}),
				],
			},
			roomsForParticipants: [ROOM_1],
			rooms: [{ id: ROOM_1, name: "Direct Room", type: "dm" }],
		});
		const service = createNativeRelationshipsGraphService(runtime, {
			async searchContacts() {
				return [{ entityId: ALICE }, { entityId: ALICE_ALT }];
			},
			async getContact(entityId: UUID) {
				return entityId === ALICE
					? { entityId: ALICE, customFields: { email: "alice@example.com" } }
					: { entityId: ALICE_ALT };
			},
			async getCandidateMerges() {
				return [];
			},
		});

		const detail = await service.getPersonDetail(ALICE_ALT);

		expect(detail).not.toBeNull();
		expect(detail?.primaryEntityId).toBe(ALICE);
		expect(detail?.memberEntityIds).toContain(ALICE_ALT);
		expect(detail?.identityEdges).toEqual([
			{
				id: "link-1",
				sourceEntityId: ALICE,
				targetEntityId: ALICE_ALT,
				confidence: 1,
				status: "confirmed",
			},
		]);

		const emailFact = detail?.facts.find((fact) => fact.field === "email");
		expect(emailFact).toMatchObject({
			sourceType: "contact",
			field: "email",
			value: "alice@example.com",
			text: "Email: alice@example.com",
			id: `${ALICE}:contact:email:alice@example.com`,
		});

		expect(detail?.relevantMemories.map((memory) => memory.text)).toEqual([
			"hello there",
			"alt speaks",
		]);
		expect(detail?.relevantMemories[0]?.speaker).toBe("Alice");
		expect(detail?.relevantMemories[1]?.speaker).toBe(ALICE_ALT);

		expect(detail?.recentConversations).toHaveLength(1);
		expect(detail?.recentConversations[0]?.roomName).toBe("Direct Room");
		expect(detail?.recentConversations[0]?.messages.map((m) => m.text)).toEqual(
			["alt speaks", "hello there"],
		);
	});
});

describe("cluster-aware memory helpers", () => {
	it("fans getMemoriesForCluster out across members and dedupes shared memory ids keeping the first occurrence", async () => {
		const queries: Array<UUID | undefined> = [];
		const runtime = makeRuntime({
			memoriesByEntity: {
				[ALICE]: [
					makeMemory({ id: "dup", entityId: ALICE, text: "from alice" }),
					makeMemory({ id: "own-a", entityId: ALICE, text: "only alice" }),
				],
				[ALICE_ALT]: [
					makeMemory({ id: "dup", entityId: ALICE_ALT, text: "from alt" }),
					makeMemory({ id: "own-b", entityId: ALICE_ALT, text: "only alt" }),
				],
			},
			relationshipsService: {
				getMemberEntityIds: async (entityId: UUID) =>
					entityId === ALICE ? [ALICE, ALICE_ALT] : [entityId],
			},
			onGetMemories: (query) => {
				queries.push(query.entityId);
			},
		});

		const memories = await getMemoriesForCluster(runtime, ALICE, {
			tableName: "messages",
		});

		expect(queries).toEqual([ALICE, ALICE_ALT]);
		expect(memories.map((memory) => memory.id)).toEqual([
			"dup",
			"own-a",
			"own-b",
		]);
		expect(memories[0]?.content.text).toBe("from alice");
	});

	it("falls back to the single-entity query without a cluster resolver or with empty membership", async () => {
		const queries: Array<UUID | undefined> = [];
		const noResolver = makeRuntime({
			memoriesByEntity: {
				[ALICE]: [makeMemory({ id: "m1", entityId: ALICE, text: "solo" })],
			},
			onGetMemories: (query) => {
				queries.push(query.entityId);
			},
		});
		const solo = await getMemoriesForCluster(noResolver, ALICE, {
			tableName: "messages",
		});
		expect(queries).toEqual([ALICE]);
		expect(solo).toHaveLength(1);

		queries.length = 0;
		const emptyMembers = makeRuntime({
			relationshipsService: {
				getMemberEntityIds: async () => [],
			},
			memoriesByEntity: {
				[ALICE]: [makeMemory({ id: "m2", entityId: ALICE, text: "fallback" })],
			},
			onGetMemories: (query) => {
				queries.push(query.entityId);
			},
		});
		const fallback = await getMemoriesForCluster(emptyMembers, ALICE, {
			tableName: "messages",
		});
		expect(queries).toEqual([ALICE]);
		expect(fallback.map((memory) => memory.id)).toEqual(["m2"]);
	});

	it("fans searchMemoriesForCluster across members with the caller's embedding and dedupes results", async () => {
		const seenEmbeddings: Array<number[] | undefined> = [];
		const runtime = makeRuntime({
			searchResultsByEntity: {
				[ALICE]: [
					makeMemory({ id: "hit-dup", entityId: ALICE, text: "alice hit" }),
				],
				[ALICE_ALT]: [
					makeMemory({ id: "hit-dup", entityId: ALICE_ALT, text: "alt hit" }),
					makeMemory({ id: "hit-b", entityId: ALICE_ALT, text: "alt only" }),
				],
			},
			relationshipsService: {
				getMemberEntityIds: async () => [ALICE, ALICE_ALT],
			},
			onSearchMemories: (query) => {
				seenEmbeddings.push(query.embedding);
			},
		});

		const embedding = [0.25, 0.75];
		const hits = await searchMemoriesForCluster(runtime, ALICE, {
			tableName: "messages",
			embedding,
		});

		expect(seenEmbeddings).toEqual([embedding, embedding]);
		expect(hits.map((memory) => memory.id)).toEqual(["hit-dup", "hit-b"]);
		expect(hits[0]?.content.text).toBe("alice hit");
	});
});
