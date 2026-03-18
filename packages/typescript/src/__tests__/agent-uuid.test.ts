import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type {
	Agent,
	Character,
	Entity,
	IDatabaseAdapter,
	UUID,
} from "../types";

const stringToUuid = (id: string): UUID => id as UUID;

const baseCharacterDefaults = {
	templates: {},
	messageExamples: [],
	postExamples: [],
	topics: [],
	adjectives: [],
	knowledge: [],
	plugins: [],
	secrets: {},
} as const;

/**
 * Test suite to verify agent UUID identification behavior.
 * - Agents are uniquely identified by UUID
 * - Multiple agents with the same name are allowed when they have explicit different UUIDs
 * - Agents without explicit IDs get deterministic UUIDs from their names
 */
describe("Agent UUID Identification", () => {
	let mockAdapter: IDatabaseAdapter;
	let adapterReady = false;
	const agentStore = new Map<UUID, Agent>();

	beforeEach(() => {
		vi.clearAllMocks();
		adapterReady = false;
		agentStore.clear();

		// Create a mock adapter that stores agents by UUID
		mockAdapter = {
			db: {},
			init: vi.fn().mockImplementation(async () => {
				adapterReady = true;
			}),
			initialize: vi.fn().mockResolvedValue(undefined),
			runMigrations: vi.fn().mockResolvedValue(undefined),
			isReady: vi.fn().mockImplementation(async () => adapterReady),
			close: vi.fn().mockImplementation(async () => {
				adapterReady = false;
			}),
			getConnection: vi.fn().mockResolvedValue({}),
			getAgentsByIds: vi.fn().mockImplementation(async (agentIds: UUID[]) => {
				return agentIds
					.map((id) => agentStore.get(id))
					.filter(Boolean) as Agent[];
			}),
			getAgents: vi.fn().mockImplementation(async () => {
				return Array.from(agentStore.values());
			}),
			createAgents: vi
				.fn()
				.mockImplementation(async (agents: Partial<Agent>[]) => {
					const ids: UUID[] = [];
					for (const agent of agents) {
						if (!agent.id) continue;
						const rawBio = agent.bio;
						const normalizedBio = Array.isArray(rawBio)
							? rawBio
							: [rawBio ?? "An AI agent"];
						const fullAgent: Agent = {
							...baseCharacterDefaults,
							id: agent.id,
							name: agent.name || "Unknown",
							username: agent.username,
							bio: normalizedBio,
							createdAt: agent.createdAt || Date.now(),
							updatedAt: agent.updatedAt || Date.now(),
						};
						agentStore.set(agent.id, fullAgent);
						ids.push(agent.id);
					}
					return ids;
				}),
			upsertAgents: vi
				.fn()
				.mockImplementation(async (agents: Partial<Agent>[]) => {
					for (const agent of agents) {
						if (agent.id) {
							agentStore.set(agent.id, {
								...baseCharacterDefaults,
								...agent,
								id: agent.id,
							} as Agent);
						}
					}
				}),
			updateAgents: vi
				.fn()
				.mockImplementation(
					async (updates: Array<{ agentId: UUID; agent: Partial<Agent> }>) => {
						for (const { agentId, agent: updates2 } of updates) {
							const existing = agentStore.get(agentId);
							if (existing) {
								agentStore.set(agentId, {
									...existing,
									...updates2,
									updatedAt: Date.now(),
								});
							}
						}
						return true;
					},
				),
			deleteAgents: vi.fn().mockImplementation(async (agentIds: UUID[]) => {
				for (const id of agentIds) {
					agentStore.delete(id);
				}
				return true;
			}),
			ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
			getEntitiesByIds: vi
				.fn()
				.mockImplementation(async (entityIds: UUID[]) => {
					// Return entities for the requested IDs
					return entityIds.map((id) => ({
						id,
						agentId: id,
						names: ["Test Entity"],
						metadata: {},
					}));
				}),
			createEntities: vi
				.fn()
				.mockImplementation(async (entities: Entity[]) =>
					entities.map((e) => e.id ?? (uuidv4() as UUID)),
				),
			getMemories: vi.fn().mockResolvedValue([]),
			getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
			getMemoriesByIds: vi.fn().mockResolvedValue([]),
			getCachedEmbeddings: vi.fn().mockResolvedValue([]),
			createLogs: vi.fn().mockResolvedValue(undefined),
			searchMemories: vi.fn().mockResolvedValue([]),
			createMemories: vi.fn().mockResolvedValue([]),
			deleteMemories: vi.fn().mockResolvedValue(undefined),
			deleteManyMemories: vi.fn().mockResolvedValue(undefined),
			deleteAllMemories: vi.fn().mockResolvedValue(undefined),
			countMemories: vi.fn().mockResolvedValue(0),
			getRoomsByIds: vi.fn().mockResolvedValue([]),
			createRooms: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
			deleteRooms: vi.fn().mockResolvedValue(undefined),
			getRoomsForParticipant: vi.fn().mockResolvedValue([]),
			getRoomsForParticipants: vi.fn().mockResolvedValue([]),
			createRoomParticipants: vi
				.fn()
				.mockImplementation(async (entityIds: UUID[]) => entityIds),
			deleteParticipants: vi.fn().mockResolvedValue(true),
			getParticipantsForEntity: vi.fn().mockResolvedValue([]),
			getParticipantsForRoom: vi.fn().mockResolvedValue([]),
			getParticipantsForRooms: vi.fn().mockResolvedValue([]),
			getParticipantUserState: vi.fn().mockResolvedValue(null),
			getParticipantUserStates: vi.fn().mockResolvedValue([]),
			setParticipantUserState: vi.fn().mockResolvedValue(undefined),
			updateParticipantUserState: vi.fn().mockResolvedValue(undefined),
			getEntitiesForRooms: vi.fn().mockResolvedValue([]),
			createRelationships: vi.fn().mockResolvedValue(true),
			getRelationship: vi.fn().mockResolvedValue(null),
			getRelationships: vi.fn().mockResolvedValue([]),
			getRelationshipsByIds: vi.fn().mockResolvedValue([]),
			getEntitiesForRoom: vi.fn().mockResolvedValue([]),
			updateEntities: vi.fn().mockResolvedValue(undefined),
			deleteEntities: vi.fn().mockResolvedValue(undefined),
			getComponent: vi.fn().mockResolvedValue(null),
			getComponents: vi.fn().mockResolvedValue([]),
			getComponentsByIds: vi.fn().mockResolvedValue([]),
			createComponents: vi.fn().mockResolvedValue(true),
			updateComponents: vi.fn().mockResolvedValue(undefined),
			deleteComponents: vi.fn().mockResolvedValue(undefined),
			createWorlds: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
			getWorldsByIds: vi.fn().mockResolvedValue([]),
			getAllWorlds: vi.fn().mockResolvedValue([]),
			updateWorlds: vi.fn().mockResolvedValue(undefined),
			updateRooms: vi.fn().mockResolvedValue(undefined),
			getRoomsByWorld: vi.fn().mockResolvedValue([]),
			updateRelationships: vi.fn().mockResolvedValue(undefined),
			deleteRelationships: vi.fn().mockResolvedValue(undefined),
			getCaches: vi.fn().mockResolvedValue(new Map()),
			setCaches: vi.fn().mockResolvedValue(true),
			deleteCaches: vi.fn().mockResolvedValue(true),
			createTasks: vi.fn().mockResolvedValue([]),
			getTasks: vi.fn().mockResolvedValue([]),
			getTasksByIds: vi.fn().mockResolvedValue([]),
			getTasksByName: vi.fn().mockResolvedValue([]),
			updateTasks: vi.fn().mockResolvedValue(undefined),
			deleteTasks: vi.fn().mockResolvedValue(undefined),
			updateMemories: vi.fn().mockResolvedValue([true]),
			getLogs: vi.fn().mockResolvedValue([]),
			deleteLogs: vi.fn().mockResolvedValue(undefined),
			getPairingRequests: vi.fn().mockResolvedValue([]),
			getPairingAllowlist: vi.fn().mockResolvedValue([]),
			createPairingRequests: vi.fn().mockResolvedValue([]),
			updatePairingRequests: vi.fn().mockResolvedValue(undefined),
			deletePairingRequests: vi.fn().mockResolvedValue(undefined),
			createPairingAllowlistEntries: vi.fn().mockResolvedValue([]),
			deletePairingAllowlistEntries: vi.fn().mockResolvedValue(undefined),
			getAgentRunSummaries: vi
				.fn()
				.mockResolvedValue({ runs: [], totalCount: 0 }),
			deleteWorlds: vi.fn().mockResolvedValue(undefined),
			deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
			getMemoriesByWorldId: vi.fn().mockResolvedValue([]),
		} as IDatabaseAdapter;
	});

	it("should allow multiple agents with the same name but different UUIDs", async () => {
		const sharedName = "TestAgent";
		const agentId1 = stringToUuid(uuidv4());
		const agentId2 = stringToUuid(uuidv4());

		// Create first agent
		const character1: Character = {
			...baseCharacterDefaults,
			id: agentId1,
			name: sharedName,
			bio: ["First agent with this name"],
		};

		const runtime1 = new AgentRuntime({
			character: character1,
			adapter: mockAdapter,
		});

		await runtime1.initialize({ skipMigrations: true });
		await runtime1.ensureAgentExists(character1);

		// Create second agent with same name but different ID
		const character2: Character = {
			...baseCharacterDefaults,
			id: agentId2,
			name: sharedName,
			bio: ["Second agent with this name"],
		};

		const runtime2 = new AgentRuntime({
			character: character2,
			adapter: mockAdapter,
		});

		await runtime2.initialize({ skipMigrations: true });
		await runtime2.ensureAgentExists(character2);

		// Verify both agents exist in the store
		const allAgents = await mockAdapter.getAgents();
		expect(allAgents).toHaveLength(2);

		// Verify they have different IDs
		const ids = allAgents.map((a) => a.id);
		expect(ids).toContain(agentId1);
		expect(ids).toContain(agentId2);
		expect(ids[0]).not.toBe(ids[1]);

		// Verify they have the same name
		const names = allAgents.map((a) => a.name);
		expect(names[0]).toBe(sharedName);
		expect(names[1]).toBe(sharedName);

		// Verify we can retrieve each agent by their unique ID
		const agent1 = (await mockAdapter.getAgentsByIds([agentId1]))[0];
		const agent2 = (await mockAdapter.getAgentsByIds([agentId2]))[0];

		expect(agent1).toBeTruthy();
		expect(agent2).toBeTruthy();
		expect(agent1?.id).toBe(agentId1);
		expect(agent2?.id).toBe(agentId2);
		expect(agent1?.name).toBe(sharedName);
		expect(agent2?.name).toBe(sharedName);
	});

	it("should generate deterministic UUIDs from character names", async () => {
		const sharedName = "TestAgent";

		// Simulate what happens when a character without ID is processed
		const character1: Character = {
			...baseCharacterDefaults,
			name: sharedName,
			bio: ["First agent"],
		};

		const character2: Character = {
			...baseCharacterDefaults,
			name: sharedName,
			bio: ["Second agent"],
		};

		// Create runtimes - constructor should generate deterministic UUIDs from name
		const runtime1 = new AgentRuntime({
			character: character1,
			adapter: mockAdapter,
		});

		const runtime2 = new AgentRuntime({
			character: character2,
			adapter: mockAdapter,
		});

		// Verify same UUIDs were generated for same name
		expect(runtime1.agentId).toBe(runtime2.agentId);

		await runtime1.initialize({ skipMigrations: true });
		await runtime1.ensureAgentExists({ ...character1, id: runtime1.agentId });

		// Second runtime will update the existing agent since it has the same ID
		await runtime2.initialize({ skipMigrations: true });
		await runtime2.ensureAgentExists({ ...character2, id: runtime2.agentId });

		// Verify only one agent exists (same ID means same agent)
		const allAgents = await mockAdapter.getAgents();
		expect(allAgents).toHaveLength(1);
		expect(allAgents[0].name).toBe(sharedName);
	});

	it("should use character ID if provided, ignoring name-based generation", async () => {
		const explicitId = stringToUuid(uuidv4());
		const character: Character = {
			...baseCharacterDefaults,
			id: explicitId,
			name: "TestAgent",
			bio: ["Agent with explicit ID"],
		};

		const runtime = new AgentRuntime({
			character,
			adapter: mockAdapter,
		});

		// Verify runtime uses the explicit ID
		expect(runtime.agentId).toBe(explicitId);

		await runtime.initialize({ skipMigrations: true });
		await runtime.ensureAgentExists(character);

		// Verify agent created with the explicit ID
		const agent = (await mockAdapter.getAgentsByIds([explicitId]))[0];
		expect(agent).toBeTruthy();
		expect(agent?.id).toBe(explicitId);
	});

	it("should update agent by UUID, not by name", async () => {
		const agentId = stringToUuid(uuidv4());
		const initialName = "OriginalName";
		const updatedName = "UpdatedName";

		// Create agent with initial name
		const character: Character = {
			...baseCharacterDefaults,
			id: agentId,
			name: initialName,
			bio: ["Initial bio"],
		};

		const runtime = new AgentRuntime({
			character,
			adapter: mockAdapter,
		});

		await runtime.initialize({ skipMigrations: true });
		await runtime.ensureAgentExists(character);

		// Update agent name
		await mockAdapter.updateAgents([{ agentId, agent: { name: updatedName } }]);

		// Verify agent still has same ID but updated name
		const agent = (await mockAdapter.getAgentsByIds([agentId]))[0];
		expect(agent?.id).toBe(agentId);
		expect(agent?.name).toBe(updatedName);

		// Verify no duplicate was created
		const allAgents = await mockAdapter.getAgents();
		expect(allAgents).toHaveLength(1);
	});

	it("should allow creating multiple agents with same name via ensureAgentExists", async () => {
		const sharedName = "SharedName";
		const agentId1 = stringToUuid(uuidv4());
		const agentId2 = stringToUuid(uuidv4());

		const runtime1 = new AgentRuntime({
			agentId: agentId1,
			character: {
				...baseCharacterDefaults,
				name: sharedName,
				bio: ["First"],
			},
			adapter: mockAdapter,
		});

		const runtime2 = new AgentRuntime({
			agentId: agentId2,
			character: {
				...baseCharacterDefaults,
				name: sharedName,
				bio: ["Second"],
			},
			adapter: mockAdapter,
		});

		await runtime1.initialize({ skipMigrations: true });
		await runtime1.ensureAgentExists({
			...baseCharacterDefaults,
			id: agentId1,
			name: sharedName,
			bio: ["First"],
		});
		await runtime2.initialize({ skipMigrations: true });
		await runtime2.ensureAgentExists({
			...baseCharacterDefaults,
			id: agentId2,
			name: sharedName,
			bio: ["Second"],
		});

		// Both should exist
		const agent1 = (await mockAdapter.getAgentsByIds([agentId1]))[0];
		const agent2 = (await mockAdapter.getAgentsByIds([agentId2]))[0];

		expect(agent1).toBeTruthy();
		expect(agent2).toBeTruthy();
		expect(agent1?.name).toBe(sharedName);
		expect(agent2?.name).toBe(sharedName);
		expect(agent1?.id).not.toBe(agent2?.id);

		const allAgents = await mockAdapter.getAgents();
		expect(allAgents).toHaveLength(2);
	});
});
