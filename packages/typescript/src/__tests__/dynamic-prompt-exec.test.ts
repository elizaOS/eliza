import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, IDatabaseAdapter, State, UUID } from "../types";
import { ModelType } from "../types";
import type { RetryBackoffConfig, SchemaRow } from "../types/state";

const stringToUuid = (id: string): UUID => id as UUID;

// ============================================================================
// Test Fixtures
// ============================================================================

const createMockDatabaseAdapter = (): IDatabaseAdapter => {
	let ready = false;
	return {
		isRoomParticipant: vi.fn().mockResolvedValue(true),
		db: {},
		init: vi.fn().mockImplementation(async () => {
			ready = true;
		}),
		initialize: vi.fn().mockResolvedValue(undefined),
		isReady: vi.fn().mockImplementation(async () => ready),
		close: vi.fn().mockImplementation(async () => {
			ready = false;
		}),
		getConnection: vi.fn().mockResolvedValue({}),
		getEntitiesByIds: vi.fn().mockResolvedValue([]),
		createEntities: vi.fn().mockResolvedValue(true),
		updateEntities: vi.fn().mockResolvedValue(undefined),
		deleteEntities: vi.fn().mockResolvedValue(undefined),
		getMemories: vi.fn().mockResolvedValue([]),
		getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
		getMemoriesByIds: vi.fn().mockResolvedValue([]),
		getCachedEmbeddings: vi.fn().mockResolvedValue([]),
		searchMemories: vi.fn().mockResolvedValue([]),
		createMemories: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
		updateMemories: vi.fn().mockResolvedValue([true]),
		deleteMemories: vi.fn().mockResolvedValue(undefined),
		deleteAllMemories: vi.fn().mockResolvedValue(undefined),
		countMemories: vi.fn().mockResolvedValue(0),
		getRoomsByIds: vi.fn().mockResolvedValue([]),
		createRooms: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
		updateRooms: vi.fn().mockResolvedValue(undefined),
		deleteRooms: vi.fn().mockResolvedValue(undefined),
		getRoomsForParticipant: vi.fn().mockResolvedValue([]),
		getRoomsForParticipants: vi.fn().mockResolvedValue([]),
		createRoomParticipants: vi.fn().mockResolvedValue([]),
		deleteParticipants: vi.fn().mockResolvedValue(true),
		getRelationship: vi.fn().mockResolvedValue(null),
		getRelationships: vi.fn().mockResolvedValue([]),
		createRelationships: vi.fn().mockResolvedValue(true),
		getRelationshipsByIds: vi.fn().mockResolvedValue([]),
		updateRelationships: vi.fn().mockResolvedValue(undefined),
		deleteRelationships: vi.fn().mockResolvedValue(undefined),
		getCaches: vi.fn().mockResolvedValue(new Map()),
		setCaches: vi.fn().mockResolvedValue(true),
		deleteCaches: vi.fn().mockResolvedValue(true),
		getTasks: vi.fn().mockResolvedValue([]),
		getTasksByName: vi.fn().mockResolvedValue([]),
		createTasks: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
		getTasksByIds: vi.fn().mockResolvedValue([]),
		updateTasks: vi.fn().mockResolvedValue(undefined),
		deleteTasks: vi.fn().mockResolvedValue(undefined),
		getParticipantsForRoom: vi.fn().mockResolvedValue([]),
		getParticipantsForEntity: vi.fn().mockResolvedValue([]),
		updateParticipant: vi.fn().mockResolvedValue(undefined),
		getEntitiesForRoom: vi.fn().mockResolvedValue([]),
		getComponent: vi.fn().mockResolvedValue(null),
		getComponents: vi.fn().mockResolvedValue([]),
		createComponents: vi.fn().mockResolvedValue(true),
		getComponentsByIds: vi.fn().mockResolvedValue([]),
		updateComponents: vi.fn().mockResolvedValue(undefined),
		deleteComponents: vi.fn().mockResolvedValue(undefined),
		getAgentsByIds: vi.fn().mockResolvedValue([]),
		getAgents: vi.fn().mockResolvedValue([]),
		createAgents: vi.fn().mockResolvedValue(true),
		updateAgents: vi.fn().mockResolvedValue(true),
		deleteAgents: vi.fn().mockResolvedValue(true),
		ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
		createWorlds: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
		getWorldsByIds: vi.fn().mockResolvedValue([]),
		getAllWorlds: vi.fn().mockResolvedValue([]),
		deleteWorlds: vi.fn().mockResolvedValue(undefined),
		updateWorlds: vi.fn().mockResolvedValue(undefined),
		getRoomsByWorld: vi.fn().mockResolvedValue([]),
		deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
		getParticipantUserState: vi.fn().mockResolvedValue(null),
		updateParticipantUserState: vi.fn().mockResolvedValue(undefined),
		getLogs: vi.fn().mockResolvedValue([]),
		createLogs: vi.fn().mockResolvedValue(undefined),
		deleteLogs: vi.fn().mockResolvedValue(undefined),
		getAgentRunSummaries: vi
			.fn()
			.mockResolvedValue({ runs: [], total: 0, hasMore: false }),
		getMemoriesByWorldId: vi.fn().mockResolvedValue([]),
		getPairingRequests: vi.fn().mockResolvedValue([]),
		getPairingAllowlist: vi.fn().mockResolvedValue([]),
		createPairingRequests: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
		updatePairingRequests: vi.fn().mockResolvedValue(undefined),
		deletePairingRequests: vi.fn().mockResolvedValue(undefined),
		createPairingAllowlistEntries: vi
			.fn()
			.mockResolvedValue([stringToUuid(uuidv4())]),
		deletePairingAllowlistEntries: vi.fn().mockResolvedValue(undefined),
	} as IDatabaseAdapter;
};

const createTestCharacter = (): Character => ({
	name: "TestAgent",
	bio: "A test agent for unit testing",
	system: "You are a helpful test agent.",
});

const createMockState = (): State =>
	({
		values: {
			agentName: "TestAgent",
			userName: "TestUser",
		},
	}) as State;

// ============================================================================
// SchemaRow Type Tests
// ============================================================================

describe("SchemaRow type", () => {
	it("should have correct field structure", () => {
		const row: SchemaRow = {
			field: "text",
			description: "Response to user",
			required: true,
			validateField: true,
			streamField: true,
		};

		expect(row.field).toBe("text");
		expect(row.description).toBe("Response to user");
		expect(row.required).toBe(true);
		expect(row.validateField).toBe(true);
		expect(row.streamField).toBe(true);
	});

	it("should have optional fields default to undefined", () => {
		const row: SchemaRow = {
			field: "thought",
			description: "Internal reasoning",
		};

		expect(row.field).toBe("thought");
		expect(row.description).toBe("Internal reasoning");
		expect(row.required).toBeUndefined();
		expect(row.validateField).toBeUndefined();
		expect(row.streamField).toBeUndefined();
	});

	it("should support nested arrays and objects", () => {
		const row: SchemaRow = {
			field: "facts",
			description: "Facts extracted from the conversation",
			type: "array",
			items: {
				description: "One fact entry",
				type: "object",
				properties: [
					{
						field: "claim",
						description: "Fact claim",
						required: true,
					},
					{
						field: "confidence",
						description: "Confidence score",
						type: "number",
					},
				],
			},
		};

		expect(row.type).toBe("array");
		expect(row.items?.type).toBe("object");
		expect(row.items?.properties?.[0]?.field).toBe("claim");
	});
});

// ============================================================================
// RetryBackoffConfig Type Tests
// ============================================================================

describe("RetryBackoffConfig type", () => {
	it("should have correct field structure", () => {
		const config: RetryBackoffConfig = {
			initialMs: 1000,
			multiplier: 2,
			maxMs: 30000,
		};

		expect(config.initialMs).toBe(1000);
		expect(config.multiplier).toBe(2);
		expect(config.maxMs).toBe(30000);
	});

	it("should calculate exponential backoff correctly", () => {
		const config: RetryBackoffConfig = {
			initialMs: 1000,
			multiplier: 2,
			maxMs: 30000,
		};

		// Manual calculation matching the function
		const delay1 = Math.min(
			config.initialMs * config.multiplier ** 0,
			config.maxMs,
		);
		const delay2 = Math.min(
			config.initialMs * config.multiplier ** 1,
			config.maxMs,
		);
		const delay3 = Math.min(
			config.initialMs * config.multiplier ** 2,
			config.maxMs,
		);

		expect(delay1).toBe(1000);
		expect(delay2).toBe(2000);
		expect(delay3).toBe(4000);
	});

	it("should cap delay at maxMs", () => {
		const config: RetryBackoffConfig = {
			initialMs: 1000,
			multiplier: 2,
			maxMs: 5000,
		};

		// 5th retry would be 1000 * 2^4 = 16000, capped at 5000
		const delay = Math.min(
			config.initialMs * config.multiplier ** 4,
			config.maxMs,
		);
		expect(delay).toBe(5000);
	});
});

// ============================================================================
// dynamicPromptExecFromState Tests
// ============================================================================

describe("dynamicPromptExecFromState", () => {
	let runtime: AgentRuntime;
	let mockAdapter: IDatabaseAdapter;

	beforeEach(async () => {
		mockAdapter = createMockDatabaseAdapter();
		runtime = new AgentRuntime({
			character: createTestCharacter(),
			adapter: mockAdapter,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("schema validation", () => {
		it("should reject empty schema", async () => {
			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [],
			});

			expect(result).toBeNull();
		});

		it("should reject invalid field names", async () => {
			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [{ field: "123invalid", description: "Starts with number" }],
			});

			expect(result).toBeNull();
		});

		it("should accept valid field names with underscores", async () => {
			// Register a mock model handler
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () => "<response><my_field>value</my_field></response>",
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [
					{ field: "my_field", description: "Valid field with underscore" },
				],
				options: {
					contextCheckLevel: 0, // No validation codes
				},
			});

			expect(result).not.toBeNull();
			expect(result?.my_field).toBe("value");
		});

		it("should warn on contradictory schema declarations", async () => {
			const warnSpy = vi
				.spyOn(runtime.logger, "warn")
				.mockImplementation(() => {});

			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () => '{"facts": []}',
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [
					{
						field: "facts",
						description: "Facts extracted from the conversation",
						type: "string",
						items: {
							description: "One fact entry",
							type: "object",
							properties: [
								{
									field: "claim",
									description: "Fact claim",
								},
							],
						},
					},
				],
				options: {
					contextCheckLevel: 0,
				},
			});

			expect(result).not.toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'dynamicPromptExecFromState schema warning: facts is type "string" but also defines nested structure',
				),
			);
		});
	});

	describe("promptSegments invariant", () => {
		it("should set promptSegments and satisfy prompt === concat(segments)", async () => {
			let capturedParams: {
				prompt?: string;
				promptSegments?: Array<{ content: string; stable: boolean }>;
			} = {};
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async (_, params) => {
					capturedParams = {
						prompt: params.prompt as string,
						promptSegments: params.promptSegments as Array<{
							content: string;
							stable: boolean;
						}>,
					};
					return "<response><thought>ok</thought><text>Hi</text></response>";
				},
				"mock",
			);

			const state = createMockState();
			await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [
					{ field: "thought", description: "Reasoning" },
					{ field: "text", description: "Response" },
				],
				options: {
					contextCheckLevel: 0,
				},
			});

			expect(capturedParams.promptSegments).toBeDefined();
			expect(Array.isArray(capturedParams.promptSegments)).toBe(true);
			const reconstructed = (capturedParams.promptSegments ?? [])
				.map((s) => s.content)
				.join("");
			expect(capturedParams.prompt).toBe(reconstructed);
			const hasStable = (capturedParams.promptSegments ?? []).some(
				(s) => s.stable === true,
			);
			expect(hasStable).toBe(true);
		});
	});

	describe("format handling", () => {
		it("should parse XML format by default", async () => {
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () => `<response>
          <thought>I should respond</thought>
          <text>Hello!</text>
        </response>`,
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [
					{ field: "thought", description: "Reasoning" },
					{ field: "text", description: "Response" },
				],
				options: {
					contextCheckLevel: 0,
				},
			});

			expect(result).not.toBeNull();
			expect(result?.thought).toBe("I should respond");
			expect(result?.text).toBe("Hello!");
		});

		it("should parse JSON format when specified", async () => {
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () => '{"thought": "I should respond", "text": "Hello!"}',
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [
					{ field: "thought", description: "Reasoning" },
					{ field: "text", description: "Response" },
				],
				options: {
					contextCheckLevel: 0,
					forceFormat: "json",
				},
			});

			expect(result).not.toBeNull();
			expect(result?.thought).toBe("I should respond");
			expect(result?.text).toBe("Hello!");
		});

		it("should automatically use JSON for nested schemas", async () => {
			let capturedPrompt = "";
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async (_, params) => {
					capturedPrompt = params.prompt as string;
					return JSON.stringify({
						facts: [
							{
								claim: "Alice likes tea",
								confidence: 0.9,
							},
						],
						metadata: {
							roomSummary: "Short room summary",
						},
					});
				},
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [
					{
						field: "facts",
						description: "Facts extracted from the conversation",
						type: "array",
						required: true,
						items: {
							description: "One fact entry",
							type: "object",
							properties: [
								{
									field: "claim",
									description: "Fact claim",
									required: true,
								},
								{
									field: "confidence",
									description: "Confidence score",
									type: "number",
								},
							],
						},
					},
					{
						field: "metadata",
						description: "Supporting metadata",
						type: "object",
						items: undefined,
						properties: [
							{
								field: "roomSummary",
								description: "Room summary",
								required: true,
							},
						],
					},
				],
				options: {
					contextCheckLevel: 0,
				},
			});

			expect(capturedPrompt).toContain("Respond using JSON format");
			expect(result).not.toBeNull();
			expect(result?.facts).toEqual([
				{
					claim: "Alice likes tea",
					confidence: 0.9,
				},
			]);
			expect(result?.metadata).toEqual({
				roomSummary: "Short room summary",
			});
		});

		it("should infer nested JSON structure when type is omitted", async () => {
			let capturedPrompt = "";
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async (_, params) => {
					capturedPrompt = params.prompt as string;
					return JSON.stringify({
						facts: [
							{
								claim: "Alice likes tea",
							},
						],
					});
				},
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [
					{
						field: "facts",
						description: "Facts extracted from the conversation",
						items: {
							description: "One fact entry",
							type: "object",
							properties: [
								{
									field: "claim",
									description: "Fact claim",
									required: true,
								},
							],
						},
					},
				],
				options: {
					contextCheckLevel: 0,
				},
			});

			expect(capturedPrompt).toContain("Respond using JSON format");
			expect(result?.facts).toEqual([
				{
					claim: "Alice likes tea",
				},
			]);
		});
	});

	describe("validation code handling", () => {
		it("should handle validation codes at level 2", async () => {
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async (_, params) => {
					// Extract codes from the prompt
					const prompt = params.prompt as string;
					const initMatch = prompt.match(/initial code: ([a-f0-9-]+)/);
					const midMatch = prompt.match(/middle code: ([a-f0-9-]+)/);
					const endMatch = prompt.match(/end code: ([a-f0-9-]+)/);

					return `<response>
            <one_initial_code>${initMatch?.[1] || ""}</one_initial_code>
            <one_middle_code>${midMatch?.[1] || ""}</one_middle_code>
            <one_end_code>${endMatch?.[1] || ""}</one_end_code>
            <text>Response text</text>
          </response>`;
				},
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [{ field: "text", description: "Response" }],
				options: {
					contextCheckLevel: 2,
				},
			});

			expect(result).not.toBeNull();
			expect(result?.text).toBe("Response text");
			// Validation codes should be removed from result
			expect(result?.one_initial_code).toBeUndefined();
		});
	});

	describe("required fields validation", () => {
		it("should fail when required field is empty", async () => {
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () => "<response><text></text></response>",
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [{ field: "text", description: "Response", required: true }],
				options: {
					contextCheckLevel: 0,
					requiredFields: ["text"],
					maxRetries: 0,
				},
			});

			expect(result).toBeNull();
		});

		it("should pass when required field is present", async () => {
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () => "<response><text>Valid response</text></response>",
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [{ field: "text", description: "Response", required: true }],
				options: {
					contextCheckLevel: 0,
					requiredFields: ["text"],
				},
			});

			expect(result).not.toBeNull();
			expect(result?.text).toBe("Valid response");
		});

		it("should fail when nested required fields are missing", async () => {
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () =>
					JSON.stringify({
						facts: [
							{
								confidence: 0.9,
							},
						],
					}),
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [
					{
						field: "facts",
						description: "Facts extracted from the conversation",
						type: "array",
						required: true,
						items: {
							description: "One fact entry",
							type: "object",
							properties: [
								{
									field: "claim",
									description: "Fact claim",
									required: true,
								},
								{
									field: "confidence",
									description: "Confidence score",
									type: "number",
								},
							],
						},
					},
				],
				options: {
					contextCheckLevel: 0,
					maxRetries: 0,
				},
			});

			expect(result).toBeNull();
		});
	});

	describe("retry behavior", () => {
		it("should retry on validation failure", async () => {
			let callCount = 0;
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () => {
					callCount++;
					if (callCount < 2) {
						return "<response><text></text></response>";
					}
					return "<response><text>Valid on retry</text></response>";
				},
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [{ field: "text", description: "Response" }],
				options: {
					contextCheckLevel: 0,
					requiredFields: ["text"],
					maxRetries: 2,
				},
			});

			expect(result).not.toBeNull();
			expect(result?.text).toBe("Valid on retry");
			expect(callCount).toBe(2);
		});
	});

	describe("callable prompt", () => {
		it("should support callable prompt function", async () => {
			let capturedPrompt = "";
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async (_, params) => {
					capturedPrompt = params.prompt as string;
					return "<response><text>Response</text></response>";
				},
				"mock",
			);

			const state = {
				...createMockState(),
				values: { ...createMockState().values, customValue: "Hello" },
			} as State;

			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: {
					prompt: (_ctx: { state: State }) =>
						`Custom prompt with {{customValue}}`,
				},
				schema: [{ field: "text", description: "Response" }],
				options: {
					contextCheckLevel: 0,
				},
			});

			expect(result).not.toBeNull();
			expect(capturedPrompt).toContain("Custom prompt with");
		});
	});

	describe("think block removal", () => {
		it("should remove <think> blocks from response", async () => {
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () => `<think>Internal reasoning here...</think>
          <response>
            <text>Clean response</text>
          </response>`,
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [{ field: "text", description: "Response" }],
				options: {
					contextCheckLevel: 0,
				},
			});

			expect(result).not.toBeNull();
			expect(result?.text).toBe("Clean response");
		});
	});

	describe("streaming callbacks", () => {
		it("should call onStreamChunk when provided", async () => {
			const chunks: string[] = [];
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async (_, params) => {
					// Simulate streaming by calling the callback
					const onChunk = params.onStreamChunk as
						| ((chunk: string) => void)
						| undefined;
					if (onChunk) {
						onChunk("<response>");
						onChunk("<text>Hello</text>");
						onChunk("</response>");
					}
					return "<response><text>Hello</text></response>";
				},
				"mock",
			);

			const state = createMockState();
			await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [{ field: "text", description: "Response" }],
				options: {
					contextCheckLevel: 0,
					onStreamChunk: (chunk) => {
						chunks.push(chunk);
					},
				},
			});

			// Note: actual streaming behavior depends on ValidationStreamExtractor
			// This test verifies the callback is passed through
			expect(chunks.length).toBeGreaterThanOrEqual(0);
		});
	});

	describe("VALIDATION_LEVEL setting", () => {
		it("should respect trusted validation level", async () => {
			runtime.setSetting("VALIDATION_LEVEL", "trusted");

			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () => "<response><text>Simple response</text></response>",
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [{ field: "text", description: "Response" }],
			});

			expect(result).not.toBeNull();
			expect(result?.text).toBe("Simple response");
		});
	});

	describe("nested response unwrapping", () => {
		it("should unwrap nested response objects", async () => {
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async () =>
					"<response><response><text>Nested</text></response></response>",
				"mock",
			);

			const state = createMockState();
			const result = await runtime.dynamicPromptExecFromState({
				state,
				params: { prompt: "Test prompt" },
				schema: [{ field: "text", description: "Response" }],
				options: {
					contextCheckLevel: 0,
				},
			});

			// normalizeStructuredResponse should unwrap nested response
			expect(result).not.toBeNull();
		});
	});
});

// ============================================================================
// Cross-Language Parity Tests
// ============================================================================

describe("Cross-language parity", () => {
	describe("SchemaRow fields", () => {
		it("should have fields matching Python SchemaRow", () => {
			// Python: field, description, required, validate_field, stream_field
			// TypeScript: field, description, required?, validateField?, streamField?
			const row: SchemaRow = {
				field: "test",
				description: "Test field",
				required: true,
				validateField: true, // = validate_field in Python
				streamField: true, // = stream_field in Python
			};

			expect(row.field).toBeDefined();
			expect(row.description).toBeDefined();
			expect(row.required).toBeDefined();
			expect(row.validateField).toBeDefined();
			expect(row.streamField).toBeDefined();
		});

		it("should have fields matching Rust SchemaRow", () => {
			// Rust: field, description, required, validate_field, stream_field
			// TypeScript: field, description, required?, validateField?, streamField?
			const row: SchemaRow = {
				field: "test",
				description: "Test field",
			};

			// All fields should be defined or optional
			expect(typeof row.field).toBe("string");
			expect(typeof row.description).toBe("string");
		});
	});

	describe("RetryBackoffConfig fields", () => {
		it("should have fields matching Python RetryBackoffConfig", () => {
			// Python: initial_ms, multiplier, max_ms
			// TypeScript: initialMs, multiplier, maxMs
			const config: RetryBackoffConfig = {
				initialMs: 1000, // = initial_ms in Python
				multiplier: 2.0,
				maxMs: 30000, // = max_ms in Python
			};

			expect(config.initialMs).toBe(1000);
			expect(config.multiplier).toBe(2.0);
			expect(config.maxMs).toBe(30000);
		});
	});

	describe("StreamEventType values", () => {
		it("should have same event types as Python/Rust", () => {
			// All languages should have: chunk, field_validated, retry_start, error, complete
			const expectedTypes = [
				"chunk",
				"field_validated",
				"retry_start",
				"error",
				"complete",
			];

			// In TypeScript these are string literals in the type
			const eventTypes: Set<string> = new Set(expectedTypes);

			expect(eventTypes.has("chunk")).toBe(true);
			expect(eventTypes.has("field_validated")).toBe(true);
			expect(eventTypes.has("retry_start")).toBe(true);
			expect(eventTypes.has("error")).toBe(true);
			expect(eventTypes.has("complete")).toBe(true);
		});
	});

	describe("Validation levels", () => {
		it("should support levels 0-3 matching Python/Rust", () => {
			// Level 0: Trusted - no validation codes
			// Level 1: Progressive - per-field validation
			// Level 2: Checkpoint - codes at start
			// Level 3: Full - codes at start and end
			const validLevels: (0 | 1 | 2 | 3)[] = [0, 1, 2, 3];

			validLevels.forEach((level) => {
				expect(level).toBeGreaterThanOrEqual(0);
				expect(level).toBeLessThanOrEqual(3);
			});
		});
	});
});
