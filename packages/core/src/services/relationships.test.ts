/**
 * Unit coverage for the `RelationshipsService` contact surface and its
 * exported pure helpers (`calculateRelationshipStrength`,
 * `countSharedConversationWindows`). Drives the real service against a
 * hand-built in-memory runtime (component/entity stores, recorded lifecycle
 * events, scripted relationship rows), so strength scoring, conversation-
 * window splitting, persistence round-trips, handle dedupe, merge folding,
 * follow-up thresholds, platform import, and identity clustering are asserted
 * from observed behaviour. Deterministic: no database, network, or model.
 */
import { describe, expect, it, vi } from "vitest";
import type { UUID } from "../types/primitives";
import {
	calculateRelationshipStrength,
	countSharedConversationWindows,
	EntityLifecycleEvent,
	RelationshipsService,
} from "./relationships";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ENTITY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const ENTITY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ENTITY_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const ENTITY_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;
const ROOM = "44444444-4444-4444-8444-444444444444" as UUID;
const ROOM_2 = "55555555-5555-4555-8555-555555555555" as UUID;

const HOUR = 3_600_000;
const DAY = 86_400_000;

interface StubComponent {
	id: string;
	type: string;
	agentId: string;
	entityId: string;
	roomId?: string;
	worldId?: string;
	sourceEntityId?: string;
	data?: unknown;
	createdAt?: number;
}

interface StubEntity {
	id: string;
	names: string[];
	agentId: string;
	components: StubComponent[];
}

interface RelationshipRow {
	id: UUID;
	sourceEntityId: UUID;
	targetEntityId: UUID;
	tags?: string[];
	metadata?: Record<string, unknown>;
}

function confirmedLink(
	id: string,
	source: UUID,
	target: UUID,
): RelationshipRow {
	return {
		id,
		sourceEntityId: source,
		targetEntityId: target,
		tags: ["identity_link"],
		metadata: { status: "confirmed" },
	};
}

function buildStore() {
	return {
		components: new Map<string, StubComponent>(),
		entities: new Map<string, StubEntity>(),
		emitted: [] as Array<{ event: string; payload: Record<string, unknown> }>,
		relationships: [] as RelationshipRow[],
	};
}

type Store = ReturnType<typeof buildStore>;

function buildRuntime(store: Store) {
	return {
		agentId: AGENT_ID,
		adapter: {},
		async getAllWorlds() {
			return [];
		},
		async getRoomsByWorlds() {
			return [];
		},
		async getRoomsByIds() {
			return [];
		},
		async getEntitiesForRoom() {
			return [];
		},
		async getRoomsForParticipants() {
			return [];
		},
		async getMemories() {
			return [];
		},
		async searchMemories() {
			return [];
		},
		getService() {
			return null;
		},
		async createComponent(component: StubComponent) {
			store.components.set(component.id, component);
			return true;
		},
		async updateComponent(component: StubComponent) {
			store.components.set(component.id, component);
			return true;
		},
		async deleteComponent(id: string) {
			return store.components.delete(id);
		},
		async getComponents(entityId: string) {
			return [...store.components.values()].filter(
				(component) => component.entityId === entityId,
			);
		},
		async queryEntities(query: { componentType?: string; worldId?: string }) {
			const byEntity = new Map<string, StubEntity>();
			for (const component of store.components.values()) {
				if (query.componentType && component.type !== query.componentType) {
					continue;
				}
				if (query.worldId && component.worldId !== query.worldId) {
					continue;
				}
				let entity = byEntity.get(component.entityId);
				if (!entity) {
					entity = {
						id: component.entityId,
						names: [],
						agentId: AGENT_ID,
						components: [],
					};
					byEntity.set(component.entityId, entity);
				}
				entity.components.push(component);
			}
			return [...byEntity.values()];
		},
		async getEntityById(id: string) {
			return store.entities.get(id) ?? null;
		},
		async createEntity(entity: StubEntity) {
			store.entities.set(entity.id, entity);
			return entity;
		},
		async emitEvent(event: string, payload: Record<string, unknown>) {
			store.emitted.push({ event, payload });
		},
		async getRelationships() {
			return store.relationships;
		},
	};
}

function makeService(store: Store): RelationshipsService {
	return new RelationshipsService(buildRuntime(store) as never);
}

describe("calculateRelationshipStrength", () => {
	it("scores the zero-signal floor from default quality and acquaintance bonus", () => {
		expect(calculateRelationshipStrength({ interactionCount: 0 })).toBe(14);
	});

	it("caps the interaction score at 40 points", () => {
		expect(calculateRelationshipStrength({ interactionCount: 1000 })).toBe(54);
	});

	it("caps shared conversation windows at 16 points", () => {
		expect(
			calculateRelationshipStrength({
				interactionCount: 0,
				sharedConversationWindows: 100,
			}),
		).toBe(30);
	});

	it("steps recency down through its buckets", () => {
		const base = { interactionCount: 0 };
		expect(
			calculateRelationshipStrength({
				...base,
				lastInteractionAt: new Date(Date.now() - HOUR).toISOString(),
			}),
		).toBe(44);
		expect(
			calculateRelationshipStrength({
				...base,
				lastInteractionAt: new Date(Date.now() - 3 * DAY).toISOString(),
			}),
		).toBe(39);
		expect(
			calculateRelationshipStrength({
				...base,
				lastInteractionAt: new Date(Date.now() - 14 * DAY).toISOString(),
			}),
		).toBe(34);
		expect(
			calculateRelationshipStrength({
				...base,
				lastInteractionAt: new Date(Date.now() - 60 * DAY).toISOString(),
			}),
		).toBe(24);
		expect(
			calculateRelationshipStrength({
				...base,
				lastInteractionAt: "2020-01-01T00:00:00.000Z",
			}),
		).toBe(19);
	});

	it("applies the relationship-type bonus table and zero for unrecognized types", () => {
		expect(
			calculateRelationshipStrength({
				interactionCount: 0,
				relationshipType: "family",
			}),
		).toBe(20);
		expect(
			calculateRelationshipStrength({
				interactionCount: 0,
				relationshipType: "friend",
			}),
		).toBe(18);
		expect(
			calculateRelationshipStrength({
				interactionCount: 0,
				relationshipType: "colleague",
			}),
		).toBe(16);
		expect(
			calculateRelationshipStrength({
				interactionCount: 0,
				relationshipType: "unknown",
			}),
		).toBe(10);
		expect(
			calculateRelationshipStrength({
				interactionCount: 0,
				relationshipType: "mentor",
			}),
		).toBe(10);
	});

	it("clamps the total to 100 and rounds half-point totals up", () => {
		expect(
			calculateRelationshipStrength({
				interactionCount: 500,
				messageQuality: 10,
				sharedConversationWindows: 50,
				relationshipType: "family",
				lastInteractionAt: new Date(Date.now() - HOUR).toISOString(),
			}),
		).toBe(100);
		expect(
			calculateRelationshipStrength({
				interactionCount: 1,
				messageQuality: 1.25,
			}),
		).toBe(9);
	});
});

describe("countSharedConversationWindows", () => {
	it("returns 0 for empty input and for a single relevant message", () => {
		expect(countSharedConversationWindows([], ENTITY_A, ENTITY_B)).toBe(0);
		expect(
			countSharedConversationWindows(
				[{ entityId: ENTITY_A, roomId: ROOM, createdAt: 1_000 }],
				ENTITY_A,
				ENTITY_B,
			),
		).toBe(0);
	});

	it("ignores traffic from unrelated entities entirely", () => {
		expect(
			countSharedConversationWindows(
				[
					{ entityId: ENTITY_C, roomId: ROOM, createdAt: 1_000 },
					{ entityId: ENTITY_C, roomId: ROOM, createdAt: 2_000 },
					{ entityId: ENTITY_D, roomId: ROOM, createdAt: 3_000 },
				],
				ENTITY_A,
				ENTITY_B,
			),
		).toBe(0);
	});

	it("counts a window when both parties share a room inside the window regardless of input order", () => {
		const messages = [
			{ entityId: ENTITY_B, roomId: ROOM, createdAt: 1_800_000 },
			{ entityId: ENTITY_A, roomId: ROOM, createdAt: 0 },
		];
		expect(countSharedConversationWindows(messages, ENTITY_A, ENTITY_B)).toBe(
			1,
		);
	});

	it("splits strictly-greater gaps but keeps exact-boundary gaps together", () => {
		expect(
			countSharedConversationWindows(
				[
					{ entityId: ENTITY_A, roomId: ROOM, createdAt: 0 },
					{
						entityId: ENTITY_B,
						roomId: ROOM,
						createdAt: 2 * HOUR,
					},
				],
				ENTITY_A,
				ENTITY_B,
			),
		).toBe(0);
		expect(
			countSharedConversationWindows(
				[
					{ entityId: ENTITY_A, roomId: ROOM, createdAt: 0 },
					{ entityId: ENTITY_B, roomId: ROOM, createdAt: HOUR },
				],
				ENTITY_A,
				ENTITY_B,
			),
		).toBe(1);
	});

	it("counts disjoint two-party windows and rooms independently", () => {
		expect(
			countSharedConversationWindows(
				[
					{ entityId: ENTITY_A, roomId: ROOM, createdAt: 0 },
					{ entityId: ENTITY_B, roomId: ROOM, createdAt: 300_000 },
					{ entityId: ENTITY_A, roomId: ROOM, createdAt: 3 * HOUR },
					{
						entityId: ENTITY_B,
						roomId: ROOM,
						createdAt: 3 * HOUR + 300_000,
					},
				],
				ENTITY_A,
				ENTITY_B,
			),
		).toBe(2);
		expect(
			countSharedConversationWindows(
				[
					{ entityId: ENTITY_A, roomId: ROOM, createdAt: 0 },
					{ entityId: ENTITY_B, roomId: ROOM, createdAt: 60_000 },
					{ entityId: ENTITY_A, roomId: ROOM_2, createdAt: 2 * HOUR },
					{
						entityId: ENTITY_B,
						roomId: ROOM_2,
						createdAt: 2 * HOUR + 60_000,
					},
					{ entityId: ENTITY_C, roomId: ROOM, createdAt: 4 * HOUR },
				],
				ENTITY_A,
				ENTITY_B,
			),
		).toBe(2);
	});

	it("groups messages without a string roomId under one shared bucket", () => {
		expect(
			countSharedConversationWindows(
				[
					{ entityId: ENTITY_A, createdAt: 0 },
					{ entityId: ENTITY_B, createdAt: 1_000 },
				],
				ENTITY_A,
				ENTITY_B,
			),
		).toBe(1);
	});

	it("honours a custom window size", () => {
		const messages = [
			{ entityId: ENTITY_A, roomId: ROOM, createdAt: 0 },
			{ entityId: ENTITY_B, roomId: ROOM, createdAt: 90_000 },
		];
		expect(countSharedConversationWindows(messages, ENTITY_A, ENTITY_B)).toBe(
			1,
		);
		expect(
			countSharedConversationWindows(messages, ENTITY_A, ENTITY_B, 60_000),
		).toBe(0);
	});
});

describe("RelationshipsService contact lifecycle", () => {
	it("stores rolodex defaults, persists a contact_info component, and emits lifecycle events", async () => {
		const store = buildStore();
		store.entities.set(ENTITY_A, {
			id: ENTITY_A,
			names: ["Ada"],
			agentId: AGENT_ID,
			components: [],
		});
		const service = makeService(store);

		const contact = await service.addContact(
			ENTITY_A,
			["friend"],
			{ timezone: "UTC" },
			{ displayName: "Ada" },
		);

		expect(contact.entityId).toBe(ENTITY_A);
		expect(contact.categories).toEqual(["friend"]);
		expect(contact.tags).toEqual([]);
		expect(contact.privacyLevel).toBe("private");
		expect(contact.relationshipStatus).toBe("active");
		expect(contact.handles).toEqual([]);
		expect(contact.interactions).toEqual([]);

		expect(store.components.size).toBe(1);
		const stored = [...store.components.values()][0];
		expect(stored.type).toBe("contact_info");
		expect(stored.agentId).toBe(AGENT_ID);
		expect(stored.sourceEntityId).toBe(AGENT_ID);

		expect(store.emitted).toHaveLength(1);
		expect(store.emitted[0].event).toBe(EntityLifecycleEvent.UPDATED);
		expect(store.emitted[0].payload.source).toBe("relationships");

		await service.addContact(ENTITY_B);
		expect(store.emitted).toHaveLength(1);
	});

	it("loads persisted contacts back through queryEntities during initialize", async () => {
		const store = buildStore();
		const writer = makeService(store);
		await writer.addContact(ENTITY_A, ["friend"]);
		await writer.addHandle(ENTITY_A, {
			platform: "email",
			identifier: "ada@example.com",
		});

		const reader = new RelationshipsService(buildRuntime(store) as never);
		await reader.initialize(buildRuntime(store) as never);

		const loaded = await reader.getContact(ENTITY_A);
		expect(loaded).not.toBeNull();
		expect(loaded?.categories).toEqual(["friend"]);
		expect(loaded?.handles).toHaveLength(1);
		expect(loaded?.handles[0].identifier).toBe("ada@example.com");
	});

	it("merges updates onto the existing record and cannot reassign entityId", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addContact(ENTITY_A);

		const updated = await service.updateContact(ENTITY_A, {
			categories: ["vip"],
			entityId: ENTITY_B,
		});

		expect(updated?.entityId).toBe(ENTITY_A);
		expect(updated?.categories).toEqual(["vip"]);
		const stored = [...store.components.values()][0];
		const persistedData = stored.data as { entityId: string };
		expect(persistedData.entityId).toBe(ENTITY_A);
	});

	it("returns null when updating a missing contact", async () => {
		const service = makeService(buildStore());
		expect(await service.updateContact(ENTITY_A, { tags: ["x"] })).toBeNull();
	});

	it("removes stored components and reports false for unknown contacts", async () => {
		const store = buildStore();
		const service = makeService(store);
		expect(await service.removeContact(ENTITY_A)).toBe(false);

		await service.addContact(ENTITY_A);
		expect(await service.removeContact(ENTITY_A)).toBe(true);
		expect(store.components.size).toBe(0);
		expect(await service.getContact(ENTITY_A)).toBeNull();
	});

	it("installs default categories on initialize and clears caches on stop", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.initialize(buildRuntime(store) as never);

		const categories = await service.getCategories();
		expect(categories.map((category) => category.id)).toEqual([
			"friend",
			"family",
			"colleague",
			"acquaintance",
			"vip",
			"business",
		]);

		await service.addCategory({ id: "mentor", name: "Mentor" });
		expect((await service.getCategories()).map((c) => c.id)).toContain(
			"mentor",
		);

		await service.stop();
		expect(await service.getCategories()).toEqual([]);
	});

	it("rejects duplicate category ids", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addCategory({ id: "mentor", name: "Mentor" });
		await expect(
			service.addCategory({ id: "mentor", name: "Mentor II" }),
		).rejects.toThrow(/already exists/);
	});
});

describe("RelationshipsService.canAccessContact", () => {
	it("enforces the privacy matrix with the agent override", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addContact(ENTITY_A);

		expect(await service.canAccessContact(ENTITY_B, ENTITY_A)).toBe(false);

		await service.setContactPrivacy(ENTITY_A, "public");
		expect(await service.canAccessContact(ENTITY_B, ENTITY_A)).toBe(true);
		expect(await service.canAccessContact(AGENT_ID, ENTITY_A)).toBe(true);

		await service.setContactPrivacy(ENTITY_A, "private");
		expect(await service.canAccessContact(ENTITY_B, ENTITY_A)).toBe(false);
		expect(await service.canAccessContact(ENTITY_A, ENTITY_A)).toBe(true);

		await service.setContactPrivacy(ENTITY_A, "restricted");
		expect(await service.canAccessContact(ENTITY_A, ENTITY_A)).toBe(false);
		expect(await service.canAccessContact(AGENT_ID, ENTITY_A)).toBe(true);

		expect(await service.canAccessContact(AGENT_ID, ENTITY_C)).toBe(false);
	});
});

describe("RelationshipsService.searchContacts", () => {
	async function seed(): Promise<{
		service: RelationshipsService;
	}> {
		const store = buildStore();
		store.entities.set(ENTITY_A, {
			id: ENTITY_A,
			names: ["Ada Lovelace"],
			agentId: AGENT_ID,
			components: [],
		});
		store.entities.set(ENTITY_B, {
			id: ENTITY_B,
			names: ["Bob"],
			agentId: AGENT_ID,
			components: [],
		});
		const service = makeService(store);
		await service.addContact(
			ENTITY_A,
			["friend"],
			{},
			{
				displayName: "Ada",
			},
		);
		await service.updateContact(ENTITY_A, { tags: ["vip-guest"] });
		await service.addContact(ENTITY_B, ["colleague"]);
		await service.updateContact(ENTITY_B, {
			tags: ["speaker"],
			privacyLevel: "public",
		});
		await service.addContact(ENTITY_C, ["family"]);
		return { service };
	}

	it("filters by category membership, tags, and privacy level", async () => {
		const { service } = await seed();

		const either = await service.searchContacts({
			categories: ["friend", "colleague"],
		});
		expect(either.map((c) => c.entityId).sort()).toEqual(
			[ENTITY_A, ENTITY_B].sort(),
		);

		const tagged = await service.searchContacts({ tags: ["speaker"] });
		expect(tagged.map((c) => c.entityId)).toEqual([ENTITY_B]);

		const privateContacts = await service.searchContacts({
			privacyLevel: "private",
		});
		expect(privateContacts.map((c) => c.entityId).sort()).toEqual(
			[ENTITY_A, ENTITY_C].sort(),
		);

		const publicContacts = await service.searchContacts({
			privacyLevel: "public",
		});
		expect(publicContacts.map((c) => c.entityId)).toEqual([ENTITY_B]);

		const combined = await service.searchContacts({
			categories: ["family"],
			privacyLevel: "private",
		});
		expect(combined.map((c) => c.entityId)).toEqual([ENTITY_C]);
	});

	it("filters further by entity name and custom display name", async () => {
		const { service } = await seed();

		expect(
			(await service.searchContacts({ searchTerm: "lovelace" })).map(
				(c) => c.entityId,
			),
		).toEqual([ENTITY_A]);
		expect(
			(await service.searchContacts({ searchTerm: "bob" })).map(
				(c) => c.entityId,
			),
		).toEqual([ENTITY_B]);
	});

	it("returns nothing for a searchTerm that matches no candidate", async () => {
		const { service } = await seed();
		expect(await service.searchContacts({ searchTerm: "zzz" })).toEqual([]);
	});
});

describe("RelationshipsService handles and interactions", () => {
	it("normalizes platform casing and trims identifiers", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addContact(ENTITY_A);

		const handle = await service.addHandle(ENTITY_A, {
			platform: " Telegram ",
			identifier: "  @ada ",
		});

		expect(handle.platform).toBe("telegram");
		expect(handle.identifier).toBe("@ada");
	});

	it("detects duplicates case-insensitively and returns the stored handle", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addContact(ENTITY_A);

		const first = await service.addHandle(ENTITY_A, {
			platform: "telegram",
			identifier: "@ada",
		});
		const duplicate = await service.addHandle(ENTITY_A, {
			platform: "TELEGRAM",
			identifier: "@ADA",
		});

		expect(duplicate).toBe(first);
		const contact = await service.getContact(ENTITY_A);
		expect(contact?.handles).toHaveLength(1);
	});

	it("demotes only the same platform when a new primary is promoted", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addContact(ENTITY_A);

		await service.addHandle(ENTITY_A, {
			platform: "telegram",
			identifier: "@ada",
			isPrimary: true,
		});
		const secondTelegram = await service.addHandle(ENTITY_A, {
			platform: "telegram",
			identifier: "@ada-alt",
			isPrimary: true,
		});
		await service.addHandle(ENTITY_A, {
			platform: "email",
			identifier: "ada@example.com",
			isPrimary: true,
		});

		const contact = await service.getContact(ENTITY_A);
		const telegramHandles = contact?.handles.filter(
			(h) => h.platform === "telegram",
		);
		expect(
			telegramHandles?.find((h) => h.identifier === "@ada")?.isPrimary,
		).toBe(false);
		expect(secondTelegram.isPrimary).toBe(true);
		const email = contact?.handles.find((h) => h.platform === "email");
		expect(email?.isPrimary).toBe(true);
	});

	it("removes handles and reports false for unknown handle ids", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addContact(ENTITY_A);
		const handle = await service.addHandle(ENTITY_A, {
			platform: "telegram",
			identifier: "@ada",
		});

		expect(
			await service.removeHandle(
				ENTITY_A,
				"00000000-0000-4000-8000-000000000000" as UUID,
			),
		).toBe(false);
		expect(await service.removeHandle(ENTITY_A, handle.id)).toBe(true);
		const contact = await service.getContact(ENTITY_A);
		expect(contact?.handles).toHaveLength(0);
	});

	it("keeps interaction history ordered and lastInteractionAt monotonic", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addContact(ENTITY_A);

		const later = "2026-01-06T00:00:00.000Z";
		const earlier = "2026-01-01T00:00:00.000Z";

		await service.recordInteraction({
			contactId: ENTITY_A,
			platform: "telegram",
			direction: "outbound",
			occurredAt: later,
		});
		await service.recordInteraction({
			contactId: ENTITY_A,
			platform: "telegram",
			direction: "inbound",
			occurredAt: earlier,
		});

		const contact = await service.getContact(ENTITY_A);
		expect(contact?.interactions.map((i) => i.occurredAt)).toEqual([
			earlier,
			later,
		]);
		expect(contact?.lastInteractionAt).toBe(later);

		await expect(
			service.recordInteraction({
				contactId: ENTITY_A,
				platform: "   ",
				direction: "inbound",
			}),
		).rejects.toThrow("Interaction platform is required");

		const orphan = new RelationshipsService(buildRuntime(store) as never);
		await expect(
			orphan.recordInteraction({
				contactId: ENTITY_D,
				platform: "telegram",
				direction: "inbound",
			}),
		).rejects.toThrow(/not found/);
	});
});

describe("RelationshipsService.mergeContacts", () => {
	it("refuses self-merges and missing sides", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addContact(ENTITY_A);

		await expect(service.mergeContacts(ENTITY_A, ENTITY_A)).rejects.toThrow(
			/Cannot merge a contact with itself/,
		);
		await expect(service.mergeContacts(ENTITY_A, ENTITY_D)).rejects.toThrow(
			/not found/,
		);
	});

	it("folds the secondary into the primary with deduped handles, tags, categories, and interactions", async () => {
		const store = buildStore();
		const service = makeService(store);

		await service.addContact(
			ENTITY_A,
			["friend"],
			{ timezone: "UTC" },
			{
				role: "lead",
			},
		);
		await service.addHandle(ENTITY_A, {
			platform: "telegram",
			identifier: "@ada",
		});
		await service.updateContact(ENTITY_A, { tags: ["core"] });
		await service.recordInteraction({
			contactId: ENTITY_A,
			platform: "telegram",
			direction: "outbound",
			occurredAt: "2026-01-06T00:00:00.000Z",
			externalRef: "one",
		});

		await service.addContact(
			ENTITY_B,
			["colleague", "friend"],
			{},
			{
				role: "second",
				team: "ops",
			},
		);
		await service.addHandle(ENTITY_B, {
			platform: "TELEGRAM",
			identifier: "@ADA",
		});
		await service.addHandle(ENTITY_B, {
			platform: "email",
			identifier: "b@example.com",
		});
		await service.updateContact(ENTITY_B, { tags: ["guest"] });
		await service.setRelationshipGoal(ENTITY_B, {
			goalText: "monthly call",
			targetCadenceDays: 5,
		});
		await service.recordInteraction({
			contactId: ENTITY_B,
			platform: "email",
			direction: "inbound",
			occurredAt: "2026-01-01T00:00:00.000Z",
			externalRef: "two",
		});

		const merged = await service.mergeContacts(ENTITY_A, ENTITY_B);

		expect(merged.categories.sort()).toEqual(["colleague", "friend"]);
		expect(merged.tags.sort()).toEqual(["core", "guest"]);
		expect(merged.handles).toHaveLength(2);
		expect(merged.lastInteractionAt).toBe("2026-01-06T00:00:00.000Z");
		expect(merged.relationshipGoal?.goalText).toBe("monthly call");
		expect(merged.followupThresholdDays).toBe(5);
		expect(merged.customFields.role).toBe("lead");
		expect(merged.customFields.team).toBe("ops");
		expect(merged.interactions.map((i) => i.externalRef).sort()).toEqual([
			"one",
			"two",
		]);

		expect(await service.getContact(ENTITY_B)).toBeNull();
	});
});

describe("RelationshipsService goals and followups", () => {
	it("trims goal text, stamps setAt, and adopts the cadence as threshold", async () => {
		const store = buildStore();
		const service = makeService(store);
		await service.addContact(ENTITY_A);

		const goal = await service.setRelationshipGoal(ENTITY_A, {
			goalText: "  monthly call  ",
			targetCadenceDays: 10,
		});

		expect(goal.goalText).toBe("monthly call");
		expect(Number.isNaN(new Date(goal.setAt).getTime())).toBe(false);

		const contact = await service.getContact(ENTITY_A);
		expect(contact?.followupThresholdDays).toBe(10);

		await expect(
			service.setRelationshipGoal(ENTITY_A, { goalText: "   " }),
		).rejects.toThrow("Goal text is required");
		await expect(
			service.setRelationshipGoal(ENTITY_D, { goalText: "call" }),
		).rejects.toThrow(/not found/);
	});

	it("derives cadenceHealth from goal, threshold, and interaction age", async () => {
		const now = Date.parse("2026-06-01T00:00:00.000Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const store = buildStore();
			const service = makeService(store);
			await service.addContact(ENTITY_A);

			expect(
				(await service.getRelationshipProgress(ENTITY_A))?.cadenceHealth,
			).toBe("no-goal");

			await service.setRelationshipGoal(ENTITY_A, {
				goalText: "stay in touch",
				targetCadenceDays: 10,
			});
			expect(
				(await service.getRelationshipProgress(ENTITY_A))?.cadenceHealth,
			).toBe("never-contacted");

			const atDays = async (days: number) => {
				await service.updateContact(ENTITY_A, {
					lastInteractionAt: new Date(now - days * DAY).toISOString(),
				});
				return (await service.getRelationshipProgress(ENTITY_A))?.cadenceHealth;
			};

			expect(await atDays(5)).toBe("on-track");
			expect(await atDays(9)).toBe("due");
			expect(await atDays(12)).toBe("overdue");
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("resolves the followup threshold chain and skips archived and blocked contacts", async () => {
		const asOfMs = Date.parse("2026-06-01T00:00:00.000Z");
		const stale = new Date(asOfMs - 10 * DAY).toISOString();

		const store = buildStore();
		const service = makeService(store);

		await service.addContact(ENTITY_A);
		await service.updateContact(ENTITY_A, {
			followupThresholdDays: 3,
			lastInteractionAt: stale,
		});

		await service.addContact(ENTITY_B);
		await service.updateContact(ENTITY_B, { lastInteractionAt: stale });
		await service.setRelationshipGoal(ENTITY_B, {
			goalText: "weekly",
			targetCadenceDays: 7,
		});

		await service.addContact(ENTITY_C);

		await service.addContact(ENTITY_D);
		await service.updateContact(ENTITY_D, {
			followupThresholdDays: 3,
			lastInteractionAt: stale,
			relationshipStatus: "archived",
		});

		const blocked = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0" as UUID;
		await service.addContact(blocked);
		await service.updateContact(blocked, {
			followupThresholdDays: 3,
			lastInteractionAt: stale,
			relationshipStatus: "blocked",
		});

		const overdue = await service.listOverdueFollowups({
			asOfMs,
			defaultThresholdDays: 5,
		});
		const byEntity = new Map(
			overdue.map((entry) => [entry.contact.entityId, entry]),
		);

		expect(byEntity.size).toBe(3);
		expect(byEntity.get(ENTITY_A)?.thresholdDays).toBe(3);
		expect(byEntity.get(ENTITY_B)?.thresholdDays).toBe(7);
		expect(byEntity.get(ENTITY_C)?.daysSinceInteraction).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(byEntity.get(ENTITY_C)?.thresholdDays).toBe(5);
		expect(byEntity.has(ENTITY_D)).toBe(false);
		expect(byEntity.has(blocked)).toBe(false);
	});
});

describe("RelationshipsService.importContactsFromPlatform", () => {
	it("creates entities, contacts, and primary handles from seeds", async () => {
		const store = buildStore();
		const service = makeService(store);

		const result = await service.importContactsFromPlatform("GitHub", [
			{
				platform: "GitHub",
				identifier: "  ada  ",
				displayName: "  Ada Lovelace ",
				notes: "met at conference",
				tags: ["rust"],
				categories: ["colleague"],
			},
		]);

		expect(result.skipped).toEqual([]);
		expect(result.linkedToExisting).toHaveLength(0);
		expect(result.imported).toHaveLength(1);

		const contact = result.imported[0];
		expect(contact.customFields.displayName).toBe("Ada Lovelace");
		expect(contact.preferences.notes).toBe("met at conference");
		expect(contact.tags).toEqual(["rust"]);
		expect(contact.handles).toHaveLength(1);
		expect(contact.handles[0].platform).toBe("github");
		expect(contact.handles[0].identifier).toBe("ada");
		expect(contact.handles[0].isPrimary).toBe(true);

		const entity = [...store.entities.values()][0];
		expect(entity.names).toEqual(["Ada Lovelace"]);
	});

	it("links repeat imports to the existing contact, skips blank identifiers, and rejects blank platforms", async () => {
		const store = buildStore();
		const service = makeService(store);
		const seed = {
			platform: "github",
			identifier: "ada",
		};

		const first = await service.importContactsFromPlatform("github", [seed]);
		expect(first.imported).toHaveLength(1);

		const second = await service.importContactsFromPlatform("GITHUB", [
			seed,
			{ platform: "github", identifier: "   " },
		]);
		expect(second.imported).toHaveLength(0);
		expect(second.linkedToExisting).toHaveLength(1);
		expect(second.linkedToExisting[0].entityId).toBe(
			first.imported[0].entityId,
		);
		expect(second.skipped).toEqual([
			{
				seed: { platform: "github", identifier: "   " },
				reason: "missing identifier",
			},
		]);

		await expect(
			service.importContactsFromPlatform("   ", [seed]),
		).rejects.toThrow("Platform is required for import");
	});
});

describe("RelationshipsService identity clusters", () => {
	it("always includes the seed entity even with no evidence", async () => {
		const service = makeService(buildStore());
		expect(await service.getMemberEntityIds(ENTITY_A)).toEqual([ENTITY_A]);
	});

	it("clusters confirmed identity links and ignores unconfirmed or wrongly tagged rows", async () => {
		const store = buildStore();
		store.relationships.push(confirmedLink("rel-ab", ENTITY_A, ENTITY_B));
		store.relationships.push({
			id: "rel-ac-pending",
			sourceEntityId: ENTITY_A,
			targetEntityId: ENTITY_C,
			tags: ["identity_link"],
			metadata: { status: "pending" },
		});
		store.relationships.push({
			id: "rel-cd-notlink",
			sourceEntityId: ENTITY_C,
			targetEntityId: ENTITY_D,
			tags: ["friend"],
			metadata: { status: "confirmed" },
		});
		store.relationships.push({
			id: "rel-be-nometa",
			sourceEntityId: ENTITY_B,
			targetEntityId: ENTITY_D,
			tags: ["identity_link"],
		});

		const service = makeService(store);
		const members = await service.getMemberEntityIds(ENTITY_A);

		expect(members.sort()).toEqual([ENTITY_A, ENTITY_B].sort());
	});

	it("prefers the contact-bearing member when resolving a primary, else the smallest id", async () => {
		const store = buildStore();
		store.relationships.push(confirmedLink("rel-ab", ENTITY_A, ENTITY_B));
		const service = makeService(store);

		expect(await service.resolvePrimaryEntityId(ENTITY_A)).toBe(ENTITY_A);
		expect(await service.resolvePrimaryEntityId(ENTITY_D)).toBe(ENTITY_D);

		await service.addContact(ENTITY_B);
		expect(await service.resolvePrimaryEntityId(ENTITY_A)).toBe(ENTITY_B);
	});

	it("exports the entity lifecycle event names", () => {
		expect(EntityLifecycleEvent.CREATED).toBe("entity:created");
		expect(EntityLifecycleEvent.UPDATED).toBe("entity:updated");
		expect(EntityLifecycleEvent.MERGED).toBe("entity:merged");
		expect(EntityLifecycleEvent.RESOLVED).toBe("entity:resolved");
	});
});
