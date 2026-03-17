import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type {
	Agent,
	Character,
	Entity,
	IDatabaseAdapter,
	UUID,
} from "../types";

// Helper type for vitest mocks with additional methods
interface VitestMockFunction<T extends (...args: never[]) => unknown> {
	(...args: Parameters<T>): ReturnType<T>;
	mockResolvedValueOnce: (
		value: Awaited<ReturnType<T>>,
	) => VitestMockFunction<T>;
	mockResolvedValue: (value: Awaited<ReturnType<T>>) => VitestMockFunction<T>;
	mock: {
		calls: Parameters<T>[][];
		results: ReturnType<T>[];
	};
}

describe("ensureAgentExists - Settings Persistence", () => {
	let runtime: AgentRuntime;
	let mockAdapter: IDatabaseAdapter;
	let testCharacter: Character;
	let agentId: UUID;
	let getAgentsByIdsMock: IDatabaseAdapter["getAgentsByIds"];
	let updateAgentsMock: IDatabaseAdapter["updateAgents"];
	let upsertAgentsMock: IDatabaseAdapter["upsertAgents"];
	let getEntitiesByIdsMock: IDatabaseAdapter["getEntitiesByIds"];
	let getRoomsByIdsMock: IDatabaseAdapter["getRoomsByIds"];
	let getParticipantsForRoomMock: IDatabaseAdapter["getParticipantsForRoom"];
	let createEntitiesMock: IDatabaseAdapter["createEntities"];
	let createRoomsMock: IDatabaseAdapter["createRooms"];
	let createRoomParticipantsMock: IDatabaseAdapter["createRoomParticipants"];

	beforeEach(() => {
		agentId = uuidv4() as UUID;

		testCharacter = {
			id: agentId,
			name: "TestAgent",
			username: "testagent",
			bio: [],
			templates: {},
			messageExamples: [],
			postExamples: [],
			topics: [],
			style: { all: [], chat: [], post: [] },
			adjectives: [],
			knowledge: [],
			plugins: [],
			secrets: {},
			settings: {
				MODEL: "gpt-5",
				TEMPERATURE: "0.7",
			},
		};

		// Create mock adapter with proper types using vi.fn()
		getAgentsByIdsMock = vi.fn(
			async () => [],
		) as IDatabaseAdapter["getAgentsByIds"];
		updateAgentsMock = vi.fn(
			async () => true,
		) as IDatabaseAdapter["updateAgents"];
		upsertAgentsMock = vi.fn(
			async () => {},
		) as IDatabaseAdapter["upsertAgents"];
		getEntitiesByIdsMock = vi.fn(
			async () => [],
		) as IDatabaseAdapter["getEntitiesByIds"];
		getRoomsByIdsMock = vi.fn(
			async () => [],
		) as IDatabaseAdapter["getRoomsByIds"];
		getParticipantsForRoomMock = vi.fn(
			async () => [],
		) as IDatabaseAdapter["getParticipantsForRoom"];
		createEntitiesMock = vi.fn(async (entities: Entity[]) =>
			entities.map((e) => e.id ?? (uuidv4() as UUID)),
		) as IDatabaseAdapter["createEntities"];
		createRoomsMock = vi.fn(async () => []) as IDatabaseAdapter["createRooms"];
		createRoomParticipantsMock = vi.fn(
			async (entityIds: UUID[]) => entityIds,
		) as IDatabaseAdapter["createRoomParticipants"];

		mockAdapter = {
			db: {},
			init: vi.fn(async () => {}),
			initialize: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
			isReady: vi.fn(async () => true),
			getConnection: vi.fn(async () => ({})),
			getAgentsByIds: getAgentsByIdsMock,
			getAgents: vi.fn(async () => []),
			createAgents: vi.fn(async (agents: Partial<Agent>[]) =>
				agents
					.map((a) => a.id)
					.filter((id): id is NonNullable<typeof id> => id != null),
			),
			upsertAgents: upsertAgentsMock,
			updateAgents: updateAgentsMock,
			deleteAgents: vi.fn(async () => true),
			ensureEmbeddingDimension: vi.fn(async () => {}),
			createLogs: vi.fn(async () => {}),
			runPluginMigrations: vi.fn(async () => {}),
			getEntitiesByIds: getEntitiesByIdsMock,
			getRoomsByIds: getRoomsByIdsMock,
			getParticipantsForRoom: getParticipantsForRoomMock,
			getParticipantsForRooms: vi.fn(async () => []),
			getParticipantUserStates: vi.fn(async () => []),
			setParticipantUserState: vi.fn(async () => {}),
			getEntitiesForRooms: vi.fn(async () => []),
			createEntities: createEntitiesMock,
			createRoomParticipants: createRoomParticipantsMock,
			createRooms: createRoomsMock,
			// Add other required methods with minimal implementations
			getEntitiesForRoom: vi.fn(async () => []),
			updateEntities: vi.fn(async () => {}),
			deleteEntities: vi.fn(async () => {}),
			getComponent: vi.fn(async () => null),
			getComponents: vi.fn(async () => []),
			getComponentsByIds: vi.fn(async () => []),
			createComponents: vi.fn(async () => true),
			updateComponents: vi.fn(async () => {}),
			deleteComponents: vi.fn(async () => {}),
			getMemories: vi.fn(async () => []),
			getMemoriesByIds: vi.fn(async () => []),
			getMemoriesByRoomIds: vi.fn(async () => []),
			getCachedEmbeddings: vi.fn(async () => []),
			getLogs: vi.fn(async () => []),
			deleteLogs: vi.fn(async () => {}),
			searchMemories: vi.fn(async () => []),
			createMemories: vi.fn(async () => []),
			updateMemories: vi.fn(async () => [true]),
			deleteMemories: vi.fn(async () => {}),
			deleteManyMemories: vi.fn(async () => {}),
			deleteAllMemories: vi.fn(async () => {}),
			countMemories: vi.fn(async () => 0),
			createWorlds: vi.fn(async () => ["world-id" as UUID]),
			getWorldsByIds: vi.fn(async () => []),
			getAllWorlds: vi.fn(async () => []),
			updateWorlds: vi.fn(async () => {}),
			deleteWorlds: vi.fn(async () => {}),
			getRoomsByWorld: vi.fn(async () => []),
			updateRooms: vi.fn(async () => {}),
			deleteRooms: vi.fn(async () => {}),
			deleteRoomsByWorldId: vi.fn(async () => {}),
			getRoomsForParticipant: vi.fn(async () => []),
			getRoomsForParticipants: vi.fn(async () => []),
			deleteParticipants: vi.fn(async () => true),
			getParticipantsForEntity: vi.fn(async () => []),
			isRoomParticipant: vi.fn(async () => false),
			getParticipantUserState: vi.fn(async () => null),
			updateParticipantUserState: vi.fn(async () => {}),
			createRelationships: vi.fn(async () => []),
			getRelationship: vi.fn(async () => null),
			getRelationships: vi.fn(async () => []),
			getRelationshipsByIds: vi.fn(async () => []),
			updateRelationships: vi.fn(async () => {}),
			deleteRelationships: vi.fn(async () => {}),
			getCaches: vi.fn(async () => new Map()),
			setCaches: vi.fn(async () => true),
			deleteCaches: vi.fn(async () => true),
			createTasks: vi.fn(async () => []),
			getTasks: vi.fn(async () => []),
			getTasksByIds: vi.fn(async () => []),
			getTasksByName: vi.fn(async () => []),
			updateTasks: vi.fn(async () => {}),
			deleteTasks: vi.fn(async () => {}),
			getMemoriesByWorldId: vi.fn(async () => []),
			getPairingRequests: vi.fn(async () => []),
			getPairingAllowlist: vi.fn(async () => []),
			createPairingRequests: vi.fn(async () => []),
			updatePairingRequests: vi.fn(async () => {}),
			deletePairingRequests: vi.fn(async () => {}),
			createPairingAllowlistEntries: vi.fn(async () => []),
			deletePairingAllowlistEntries: vi.fn(async () => {}),
			getAgentRunSummaries: vi.fn(async () => ({ runs: [], totalCount: 0 })),
		} as IDatabaseAdapter;

		runtime = new AgentRuntime({
			character: testCharacter,
			adapter: mockAdapter,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("should create a new agent when none exists in DB", async () => {
		const agent: Partial<Agent> = {
			id: agentId,
			name: "TestAgent",
			settings: {
				MODEL: "gpt-5",
			},
		};

		// ensureAgentExists: getAgentsByIds (no existing) -> upsertAgents -> getAgentsByIds (refreshed)
		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ ...agent, id: agentId } as Agent]);

		const result = await runtime.ensureAgentExists(agent);

		expect(mockAdapter.getAgentsByIds).toHaveBeenCalledWith([agentId]);
		expect(mockAdapter.upsertAgents).toHaveBeenCalled();
		expect(result.id).toBe(agentId);
	});

	it("should merge DB settings with character.json settings on restart", async () => {
		// Simulate DB state with persisted runtime secrets
		const existingAgentInDB: Agent = {
			id: agentId,
			name: "TestAgent",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			bio: [],
			settings: {
				SOLANA_PUBLIC_KEY: "CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4",
				secrets: {
					SOLANA_PRIVATE_KEY: "4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
				},
				OLD_SETTING: "should_be_kept",
			},
		} as Agent;

		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([existingAgentInDB]);
		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([
			{
				...existingAgentInDB,
				settings: {
					SOLANA_PUBLIC_KEY: "CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4",
					MODEL: "gpt-5",
					TEMPERATURE: "0.7",
					secrets: {
						SOLANA_PRIVATE_KEY:
							"4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
					},
					OLD_SETTING: "should_be_kept",
				},
			},
		]);

		// Character file has new settings but no wallet keys
		const characterAgent: Partial<Agent> = {
			id: agentId,
			name: "TestAgent",
			settings: {
				MODEL: "gpt-5",
				TEMPERATURE: "0.7",
			},
		};

		const _result = await runtime.ensureAgentExists(characterAgent);

		// Verify upsertAgents was called with merged settings
		expect(mockAdapter.upsertAgents).toHaveBeenCalled();
		const upsertCall = (
			upsertAgentsMock as VitestMockFunction<IDatabaseAdapter["upsertAgents"]>
		).mock.calls[0];
		const updatedAgent = (
			upsertCall[0] as Partial<Agent>[]
		)[0] as Partial<Agent>;

		// Check that DB settings were preserved
		expect(updatedAgent.settings?.SOLANA_PUBLIC_KEY).toBe(
			"CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4",
		);
		expect(updatedAgent.settings?.OLD_SETTING).toBe("should_be_kept");

		// Check that character.json settings were applied
		expect(updatedAgent.settings?.MODEL).toBe("gpt-5");
		expect(updatedAgent.settings?.TEMPERATURE).toBe("0.7");

		// Check that secrets were preserved
		const updatedAgentSettingsSecrets =
			updatedAgent.settings &&
			(updatedAgent.settings.secrets as Record<string, string> | undefined);
		expect(updatedAgentSettingsSecrets?.SOLANA_PRIVATE_KEY).toBe(
			"4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
		);
	});

	it("should allow character.json to override DB settings", async () => {
		// DB has old MODEL value
		const existingAgentInDB: Agent = {
			id: agentId,
			name: "TestAgent",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			bio: [],
			settings: {
				MODEL: "gpt-3.5-turbo",
				SOLANA_PUBLIC_KEY: "wallet123",
				secrets: {
					SOLANA_PRIVATE_KEY: "4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
				},
			},
		} as Agent;

		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([existingAgentInDB]);
		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([
			{
				...existingAgentInDB,
				settings: {
					MODEL: "gpt-5", // Updated by character.json
					SOLANA_PUBLIC_KEY: "wallet123", // Preserved from DB
					secrets: {
						SOLANA_PRIVATE_KEY:
							"4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
					},
				},
			},
		]);

		// Character file has new MODEL value
		const characterAgent: Partial<Agent> = {
			id: agentId,
			name: "TestAgent",
			settings: {
				MODEL: "gpt-5", // This should override DB value
			},
		};

		await runtime.ensureAgentExists(characterAgent);

		const upsertCall = (
			upsertAgentsMock as VitestMockFunction<IDatabaseAdapter["upsertAgents"]>
		).mock.calls[0];
		const updatedAgent = (
			upsertCall[0] as Partial<Agent>[]
		)[0] as Partial<Agent>;

		// MODEL should be overridden by character.json
		expect(updatedAgent.settings?.MODEL).toBe("gpt-5");

		// But SOLANA_PUBLIC_KEY should be preserved from DB
		expect(updatedAgent.settings?.SOLANA_PUBLIC_KEY).toBe("wallet123");
	});

	it("should deep merge secrets from both DB and character.json", async () => {
		const existingAgentInDB: Agent = {
			id: agentId,
			name: "TestAgent",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			bio: [],
			settings: {
				secrets: {
					RUNTIME_SECRET: "from_db",
					WALLET_KEY: "wallet_key_from_db",
				},
			},
		} as Agent;

		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([existingAgentInDB]);
		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([
			{
				...existingAgentInDB,
				settings: {
					secrets: {
						RUNTIME_SECRET: "from_db",
						WALLET_KEY: "wallet_key_from_db",
						API_KEY: "from_character",
					},
				},
			},
		]);

		const characterAgent: Partial<Agent> = {
			id: agentId,
			name: "TestAgent",
			settings: {
				secrets: {
					API_KEY: "from_character",
				},
			},
		};

		await runtime.ensureAgentExists(characterAgent);

		const upsertCall = (
			upsertAgentsMock as VitestMockFunction<IDatabaseAdapter["upsertAgents"]>
		).mock.calls[0];
		const updatedAgent = (
			upsertCall[0] as Partial<Agent>[]
		)[0] as Partial<Agent>;

		// Both DB and character secrets should be present
		const updatedAgentSettings = updatedAgent.settings;
		const secrets =
			updatedAgentSettings &&
			(updatedAgentSettings.secrets as Record<string, string> | undefined);
		expect(secrets?.RUNTIME_SECRET).toBe("from_db");
		expect(secrets?.WALLET_KEY).toBe("wallet_key_from_db");
		expect(secrets?.API_KEY).toBe("from_character");
	});

	it("should handle agent with no settings in DB", async () => {
		const existingAgentInDB: Agent = {
			id: agentId,
			name: "TestAgent",
			// No settings field
		} as Agent;

		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([existingAgentInDB]);
		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([
			{
				...existingAgentInDB,
				settings: {
					MODEL: "gpt-5",
				},
			},
		]);

		const characterAgent: Partial<Agent> = {
			id: agentId,
			name: "TestAgent",
			settings: {
				MODEL: "gpt-5",
			},
		};

		await runtime.ensureAgentExists(characterAgent);

		const upsertCall = (
			upsertAgentsMock as VitestMockFunction<IDatabaseAdapter["upsertAgents"]>
		).mock.calls[0];
		const updatedAgent = (
			upsertCall[0] as Partial<Agent>[]
		)[0] as Partial<Agent>;

		// Should have character settings even though DB had none
		expect(updatedAgent.settings?.MODEL).toBe("gpt-5");
	});

	it("should handle character with no settings", async () => {
		const existingAgentInDB: Agent = {
			id: agentId,
			name: "TestAgent",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			bio: [],
			settings: {
				DB_SETTING: "value",
			},
		} as Agent;

		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([existingAgentInDB]);
		(
			getAgentsByIdsMock as VitestMockFunction<
				IDatabaseAdapter["getAgentsByIds"]
			>
		).mockResolvedValueOnce([existingAgentInDB]);

		const characterAgent: Partial<Agent> = {
			id: agentId,
			name: "TestAgent",
			// No settings
		};

		await runtime.ensureAgentExists(characterAgent);

		const upsertCall = (
			upsertAgentsMock as VitestMockFunction<IDatabaseAdapter["upsertAgents"]>
		).mock.calls[0];
		const updatedAgent = (
			upsertCall[0] as Partial<Agent>[]
		)[0] as Partial<Agent>;

		// Should preserve DB settings
		expect(updatedAgent.settings?.DB_SETTING).toBe("value");
	});

	it("should throw error if agent id is not provided", async () => {
		const agent: Partial<Agent> = {
			name: "TestAgent",
		};

		await expect(runtime.ensureAgentExists(agent)).rejects.toThrow(
			"Agent id is required",
		);
	});

	describe("runtime.initialize() integration", () => {
		it("should load DB-persisted settings into runtime.character after initialization", async () => {
			// Simulate DB with persisted wallet keys
			const dbAgent = {
				id: agentId,
				name: "TestAgent",
				bio: [],
				templates: {},
				messageExamples: [],
				postExamples: [],
				topics: [],
				adjectives: [],
				knowledge: [],
				plugins: [],
				secrets: {
					SOLANA_PRIVATE_KEY: "secret_from_db",
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
				settings: {
					SOLANA_PUBLIC_KEY: "wallet_from_db",
					RUNTIME_SETTING: "from_previous_run",
				},
			} as Agent;

			// Mock getAgentsByIds to return DB agent on first call (ensureAgentExists)
			// and updated agent on second call (after update)
			(
				getAgentsByIdsMock as VitestMockFunction<
					IDatabaseAdapter["getAgentsByIds"]
				>
			)
				.mockResolvedValueOnce([dbAgent])
				.mockResolvedValueOnce([
					{
						...dbAgent,
						settings: {
							...dbAgent.settings,
							MODEL: "gpt-5", // Added from character file
						},
					},
				]);

			// Character file has different settings
			const character: Character = {
				id: agentId,
				name: "TestAgent",
				username: "test",
				bio: [],
				templates: {},
				messageExamples: [],
				postExamples: [],
				topics: [],
				style: { all: [], chat: [], post: [] },
				adjectives: [],
				knowledge: [],
				plugins: [],
				secrets: {},
				settings: {
					MODEL: "gpt-5", // New setting from character file
				},
			};

			// Create new runtime with character file settings
			const testRuntime = new AgentRuntime({
				character,
				adapter: mockAdapter,
			});

			// Before initialize, character should only have file settings
			expect(testRuntime.character.settings?.SOLANA_PUBLIC_KEY).toBeUndefined();
			expect(testRuntime.character.settings?.MODEL).toBe("gpt-5");

			// Mock the services that initialize() expects
			(
				getEntitiesByIdsMock as VitestMockFunction<
					IDatabaseAdapter["getEntitiesByIds"]
				>
			).mockResolvedValue([
				{ id: agentId, names: ["TestAgent"], metadata: {}, agentId },
			]);
			(
				getRoomsByIdsMock as VitestMockFunction<
					IDatabaseAdapter["getRoomsByIds"]
				>
			).mockResolvedValue([]);
			(
				getParticipantsForRoomMock as VitestMockFunction<
					IDatabaseAdapter["getParticipantsForRoom"]
				>
			).mockResolvedValue([]);
			(
				createEntitiesMock as VitestMockFunction<
					IDatabaseAdapter["createEntities"]
				>
			).mockResolvedValue(true);
			(
				createRoomsMock as VitestMockFunction<IDatabaseAdapter["createRooms"]>
			).mockResolvedValue([agentId]);
			(
				createRoomParticipantsMock as VitestMockFunction<
					IDatabaseAdapter["createRoomParticipants"]
				>
			).mockImplementation(async (entityIds: UUID[]) => entityIds);

			// Initialize runtime (should load DB settings into character)
			await testRuntime.initialize();

			// After initialize, character should have BOTH DB and file settings
			const testRuntimeCharacterSettings = testRuntime.character.settings;
			expect(testRuntimeCharacterSettings?.SOLANA_PUBLIC_KEY).toBe(
				"wallet_from_db",
			);
			expect(testRuntimeCharacterSettings?.RUNTIME_SETTING).toBe(
				"from_previous_run",
			);
			expect(testRuntimeCharacterSettings?.MODEL).toBe("gpt-5"); // Character file wins
			expect(testRuntime.character.secrets?.SOLANA_PRIVATE_KEY).toBe(
				"secret_from_db",
			);

			// Verify getSetting() can now access DB settings
			expect(testRuntime.getSetting("SOLANA_PUBLIC_KEY")).toBe(
				"wallet_from_db",
			);
			expect(testRuntime.getSetting("SOLANA_PRIVATE_KEY")).toBe(
				"secret_from_db",
			);
			expect(testRuntime.getSetting("RUNTIME_SETTING")).toBe(
				"from_previous_run",
			);
		});

		it("should preserve character file settings when merging with DB", async () => {
			const dbAgent: Agent = {
				id: agentId,
				name: "TestAgent",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				bio: [],
				settings: {
					MODEL: "gpt-3.5-turbo", // Old value in DB
					DB_ONLY_SETTING: "keep_me",
				},
			} as Agent;

			(
				getAgentsByIdsMock as VitestMockFunction<
					IDatabaseAdapter["getAgentsByIds"]
				>
			)
				.mockResolvedValueOnce([dbAgent])
				.mockResolvedValueOnce([
					{
						...dbAgent,
						settings: {
							MODEL: "gpt-5", // Updated by character file
							DB_ONLY_SETTING: "keep_me",
						},
					},
				]);

			const character: Character = {
				id: agentId,
				name: "TestAgent",
				username: "test",
				bio: [],
				messageExamples: [],
				postExamples: [],
				topics: [],
				style: { all: [], chat: [], post: [] },
				adjectives: [],
				settings: {
					MODEL: "gpt-5", // New value in character file
				},
			};

			const testRuntime = new AgentRuntime({
				character,
				adapter: mockAdapter,
			});

			(
				getEntitiesByIdsMock as VitestMockFunction<
					IDatabaseAdapter["getEntitiesByIds"]
				>
			).mockResolvedValue([
				{ id: agentId, names: ["TestAgent"], metadata: {}, agentId },
			]);
			(
				getRoomsByIdsMock as VitestMockFunction<
					IDatabaseAdapter["getRoomsByIds"]
				>
			).mockResolvedValue([]);
			(
				getParticipantsForRoomMock as VitestMockFunction<
					IDatabaseAdapter["getParticipantsForRoom"]
				>
			).mockResolvedValue([]);
			(
				createEntitiesMock as VitestMockFunction<
					IDatabaseAdapter["createEntities"]
				>
			).mockResolvedValue(true);
			(
				createRoomsMock as VitestMockFunction<IDatabaseAdapter["createRooms"]>
			).mockResolvedValue([agentId]);
			(
				createRoomParticipantsMock as VitestMockFunction<
					IDatabaseAdapter["createRoomParticipants"]
				>
			).mockImplementation(async (entityIds: UUID[]) => entityIds);

			await testRuntime.initialize();

			// Character file value should override DB
			expect(testRuntime.getSetting("MODEL")).toBe("gpt-5");
			// DB-only setting should be preserved
			expect(testRuntime.getSetting("DB_ONLY_SETTING")).toBe("keep_me");
		});
	});
});
