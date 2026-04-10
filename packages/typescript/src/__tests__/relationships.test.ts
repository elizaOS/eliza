import { describe, expect, it, vi } from "vitest";
import { RelationshipsService } from "../services/relationships.ts";
import type { Component, Entity } from "../types/environment";
import type { IAgentRuntime } from "../types/runtime";
import { stringToUuid } from "../utils.ts";

type MockRuntime = IAgentRuntime & {
	agentId: string;
	ensureWorldExists: ReturnType<typeof vi.fn>;
	ensureRoomExists: ReturnType<typeof vi.fn>;
	getComponent: ReturnType<typeof vi.fn>;
	queryEntities: ReturnType<typeof vi.fn>;
	getRooms: ReturnType<typeof vi.fn>;
	getEntitiesForRoom: ReturnType<typeof vi.fn>;
	getComponents: ReturnType<typeof vi.fn>;
};

const agentId = stringToUuid("relationships-test-agent");
const relationshipsWorldId = stringToUuid(`relationships-world-${agentId}`);
const relationshipsRoomId = stringToUuid(`relationships-${agentId}`);

function createRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
	return {
		agentId,
		ensureWorldExists: vi.fn().mockResolvedValue(undefined),
		ensureRoomExists: vi.fn().mockResolvedValue(undefined),
		getComponent: vi.fn().mockResolvedValue(null),
		queryEntities: vi.fn().mockResolvedValue([]),
		getRooms: vi.fn().mockResolvedValue([]),
		getEntitiesForRoom: vi.fn().mockResolvedValue([]),
		getComponents: vi.fn().mockResolvedValue([]),
		...overrides,
	} as unknown as MockRuntime;
}

describe("RelationshipsService", () => {
	it("ensures the synthetic relationships world and room during initialization", async () => {
		const runtime = createRuntime();
		const service = new RelationshipsService();

		await service.initialize(runtime);

		expect(runtime.ensureWorldExists).toHaveBeenCalledWith(
			expect.objectContaining({
				id: relationshipsWorldId,
				name: "Relationships World",
				agentId,
			}),
		);
		expect(runtime.ensureRoomExists).toHaveBeenCalledWith(
			expect.objectContaining({
				id: relationshipsRoomId,
				name: "Relationships",
				source: "relationships",
				type: "API",
				channelId: `relationships-${agentId}`,
				worldId: relationshipsWorldId,
			}),
		);
	});

	it("reloads contacts directly from the synthetic relationships world", async () => {
		const entityId = stringToUuid("mira-contact");
		const unrelatedComponent: Component = {
			id: stringToUuid(`other-contact-${entityId}-${agentId}`),
			type: "contact_info",
			agentId,
			entityId,
			roomId: stringToUuid("other-room"),
			worldId: stringToUuid("other-world"),
			sourceEntityId: agentId,
			createdAt: Date.now() - 1000,
			data: {
				entityId,
				categories: ["colleague"],
				tags: ["stale"],
				preferences: {},
				customFields: {
					displayName: "Wrong Mira",
				},
				privacyLevel: "public",
				lastModified: "2026-04-08T00:00:00.000Z",
			},
		};
		const contactComponent: Component = {
			id: stringToUuid(`contact-${entityId}-${agentId}`),
			type: "contact_info",
			agentId,
			entityId,
			roomId: relationshipsRoomId,
			worldId: relationshipsWorldId,
			sourceEntityId: agentId,
			createdAt: Date.now(),
			data: {
				entityId,
				categories: ["friend"],
				tags: ["vip"],
				preferences: {},
				customFields: {},
				privacyLevel: "private",
				lastModified: "2026-04-09T00:00:00.000Z",
			},
		};
		const storedEntity: Entity = {
			id: entityId,
			components: [unrelatedComponent, contactComponent],
		};
		const runtime = createRuntime({
			queryEntities: vi.fn().mockResolvedValue([storedEntity]),
		});
		const service = new RelationshipsService();

		await service.initialize(runtime);

		expect(runtime.queryEntities).toHaveBeenCalledWith({
			componentType: "contact_info",
			worldId: relationshipsWorldId,
			includeAllComponents: true,
		});
		expect(runtime.getRooms).not.toHaveBeenCalled();
		await expect(service.getContact(entityId)).resolves.toMatchObject({
			entityId,
			categories: ["friend"],
			tags: ["vip"],
			customFields: {},
		});
	});
});
