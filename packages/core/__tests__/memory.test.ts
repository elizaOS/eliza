import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryManager } from "../src/memory";
import type {
	DocumentMetadata,
	FragmentMetadata,
	IAgentRuntime,
	Memory,
	UUID,
} from "../src/types";
import { MemoryType } from "../src/types";

describe("MemoryManager", () => {
	const TEST_UUID_1 = "123e4567-e89b-12d3-a456-426614174000" as UUID;
	const TEST_UUID_2 = "987fcdeb-51e4-3af2-b890-312345678901" as UUID;
	const AGENT_UUID = "abcdef12-3456-7890-abcd-ef1234567890" as UUID;
	const ROOM_UUID = "11111111-2222-3333-4444-555555555555" as UUID;

	let memoryManager: MemoryManager;
	let mockDatabaseAdapter: any;
	let mockRuntime: IAgentRuntime;

	beforeEach(() => {
		mockRuntime = {
			getMemories: vi.fn(),
			createMemory: vi.fn(),
			removeMemory: vi.fn(),
			removeAllMemories: vi.fn(),
			countMemories: vi.fn(),
			getCachedEmbeddings: vi.fn(),
			searchMemories: vi.fn(),
			getMemoriesByRoomIds: vi.fn(),
			getMemoryById: vi.fn(),
			agentId: AGENT_UUID,
			useModel: vi.fn(() => Promise.resolve([])),
		} as unknown as IAgentRuntime;

		memoryManager = new MemoryManager({
			tableName: "documents",
			runtime: mockRuntime,
		});
	});

	describe("addEmbeddingToMemory", () => {
		it("should preserve existing embedding if present", async () => {
			const existingEmbedding = [0.1, 0.2, 0.3];
			const memory: Memory = {
				id: "test-id" as UUID,
				entityId: "user-id" as UUID,
				agentId: "agent-id" as UUID,
				roomId: "room-id" as UUID,
				content: { text: "test content" },
				embedding: existingEmbedding,
			};

			const result = await memoryManager.addEmbeddingToMemory(memory);
			expect(result.embedding).toBe(existingEmbedding);
		});

		it("should throw error for empty content", async () => {
			const memory: Memory = {
				id: "test-id" as UUID,
				entityId: "user-id" as UUID,
				agentId: "agent-id" as UUID,
				roomId: "room-id" as UUID,
				content: { text: "" },
			};

			await expect(memoryManager.addEmbeddingToMemory(memory)).rejects.toThrow(
				"Cannot generate embedding: Memory content is empty",
			);
		});
	});

	// describe("getMemories", () => {
	// 	it("should handle pagination parameters", async () => {
	// 		const roomId = "test-room" as UUID;
	// 		const start = 0;
	// 		const end = 5;

	// 		await memoryManager.getMemories({
	// 			roomId,
	// 			start,
	// 			end,
	// 			count: 10,
	// 			unique: true,
	// 			agentId: AGENT_UUID,
	// 		});

	// 		expect(mockDatabaseAdapter.getMemories).toHaveBeenCalledWith({
	// 			roomId,
	// 			count: 10,
	// 			unique: true,
	// 			tableName: "documents",
	// 			agentId: AGENT_UUID,
	// 			start,
	// 			end,
	// 		});
	// 	});

	// 	it("should get memories with agentId", async () => {
	// 		await memoryManager.getMemories({
	// 			roomId: ROOM_UUID,
	// 			agentId: AGENT_UUID,
	// 		});

	// 		expect(mockDatabaseAdapter.getMemories).toHaveBeenCalledWith(
	// 			expect.objectContaining({
	// 				roomId: ROOM_UUID,
	// 				agentId: AGENT_UUID,
	// 				tableName: "documents",
	// 			}),
	// 		);
	// 	});

	// 	it("should get memories without agentId", async () => {
	// 		await memoryManager.getMemories({
	// 			roomId: ROOM_UUID,
	// 		});

	// 		expect(mockDatabaseAdapter.getMemories).toHaveBeenCalledWith(
	// 			expect.objectContaining({
	// 				roomId: ROOM_UUID,
	// 				agentId: undefined,
	// 				tableName: "documents",
	// 			}),
	// 		);
	// 	});
	// });

	// describe("searchMemories", () => {
	// 	const testEmbedding = [1, 2, 3];

	// 	it("should search memories with agentId", async () => {
	// 		await memoryManager.searchMemories({
	// 			embedding: testEmbedding,
	// 			roomId: ROOM_UUID,
	// 			agentId: AGENT_UUID,
	// 		});

	// 		expect(mockDatabaseAdapter.searchMemories).toHaveBeenCalledWith(
	// 			expect.objectContaining({
	// 				roomId: ROOM_UUID,
	// 				agentId: AGENT_UUID,
	// 				embedding: testEmbedding,
	// 			}),
	// 		);
	// 	});

	// 	it("should search memories without agentId", async () => {
	// 		await memoryManager.searchMemories({
	// 			embedding: testEmbedding,
	// 			roomId: ROOM_UUID,
	// 		});

	// 		expect(mockDatabaseAdapter.searchMemories).toHaveBeenCalledWith(
	// 			expect.objectContaining({
	// 				roomId: ROOM_UUID,
	// 				agentId: undefined,
	// 				embedding: testEmbedding,
	// 			}),
	// 		);
	// 	});
	// });

	// describe("getMemoriesByRoomIds", () => {
	// 	it("should get memories by room ids with agentId", async () => {
	// 		await memoryManager.getMemoriesByRoomIds({
	// 			roomIds: [TEST_UUID_1, TEST_UUID_2],
	// 			agentId: AGENT_UUID,
	// 		});

	// 		expect(mockDatabaseAdapter.getMemoriesByRoomIds).toHaveBeenCalledWith(
	// 			expect.objectContaining({
	// 				roomIds: [TEST_UUID_1, TEST_UUID_2],
	// 				agentId: AGENT_UUID,
	// 			}),
	// 		);
	// 	});

	// 	it("should get memories by room ids without agentId", async () => {
	// 		await memoryManager.getMemoriesByRoomIds({
	// 			roomIds: [TEST_UUID_1, TEST_UUID_2],
	// 		});

	// 		expect(mockDatabaseAdapter.getMemoriesByRoomIds).toHaveBeenCalledWith(
	// 			expect.objectContaining({
	// 				roomIds: [TEST_UUID_1, TEST_UUID_2],
	// 				agentId: undefined,
	// 			}),
	// 		);
	// 	});
	// });

	describe("Metadata Handling", () => {
		it("should require type in metadata", async () => {
			const memory: Memory = {
				id: TEST_UUID_1,
				entityId: TEST_UUID_2,
				roomId: ROOM_UUID,
				content: { text: "test" },
				metadata: {
					scope: "private",
				},
			};

			await expect(memoryManager.createMemory(memory)).rejects.toThrow(
				"Metadata type is required",
			);
		});

		// it("should set default metadata with table name as type", async () => {
		// 	const memory: Memory = {
		// 		id: TEST_UUID_1,
		// 		entityId: TEST_UUID_2,
		// 		roomId: ROOM_UUID,
		// 		content: { text: "test" },
		// 	};

		// 	await memoryManager.createMemory(memory);

		// 	expect(mockDatabaseAdapter.createMemory).toHaveBeenCalledWith(
		// 		expect.objectContaining({
		// 			metadata: expect.objectContaining({
		// 				type: MemoryType.DOCUMENT,
		// 				scope: "shared",
		// 				timestamp: expect.any(Number),
		// 			}),
		// 		}),
		// 		"documents",
		// 		false,
		// 	);
		// });

		// it("should preserve existing valid metadata", async () => {
		// 	const existingMetadata: DocumentMetadata = {
		// 		type: MemoryType.DOCUMENT,
		// 		source: "user",
		// 		scope: "shared",
		// 		tags: ["important"],
		// 		timestamp: 123456789,
		// 	};

		// 	const memory: Memory = {
		// 		id: TEST_UUID_1,
		// 		entityId: TEST_UUID_2,
		// 		roomId: ROOM_UUID,
		// 		content: { text: "test" },
		// 		metadata: existingMetadata,
		// 	};

		// 	await memoryManager.createMemory(memory);

		// 	expect(mockDatabaseAdapter.createMemory).toHaveBeenCalledWith(
		// 		expect.objectContaining({
		// 			metadata: existingMetadata,
		// 		}),
		// 		"documents",
		// 		false,
		// 	);
		// });
	});

	// describe("Table Name Validation", () => {
	// 	it("should only accept valid table names", () => {
	// 		// Valid cases
	// 		expect(
	// 			() =>
	// 				new MemoryManager({
	// 					tableName: "documents",
	// 					runtime: mockRuntime,
	// 				}),
	// 		).not.toThrow();

	// 		// Invalid cases
	// 		expect(
	// 			() =>
	// 				new MemoryManager({
	// 					tableName: "not_a_valid_table" as string,
	// 					runtime: mockRuntime,
	// 				}),
	// 		).toThrow();
	// 	});

	// 	it("should enforce table-specific metadata types", async () => {
	// 		const documentsManager = new MemoryManager({
	// 			tableName: "documents",
	// 			runtime: mockRuntime,
	// 		});

	// 		const invalidMemory: Memory = {
	// 			id: TEST_UUID_1,
	// 			entityId: TEST_UUID_2,
	// 			roomId: ROOM_UUID,
	// 			content: { text: "test" },
	// 			metadata: {
	// 				type: MemoryType.FRAGMENT, // Wrong type for documents table
	// 				documentId: TEST_UUID_1,
	// 				position: 0,
	// 				timestamp: Date.now(),
	// 			},
	// 		};

	// 		await expect(
	// 			documentsManager.createMemory(invalidMemory),
	// 		).rejects.toThrow(
	// 			"Invalid metadata type for table documents. Expected document, got fragment",
	// 		);
	// 	});

	// 	it("should enforce metadata requirements", async () => {
	// 		const fragmentsManager = new MemoryManager({
	// 			tableName: "fragments",
	// 			runtime: mockRuntime,
	// 		});

	// 		// Test missing documentId
	// 		const noDocumentId: Memory = {
	// 			id: TEST_UUID_1,
	// 			entityId: TEST_UUID_2,
	// 			roomId: ROOM_UUID,
	// 			content: { text: "test" },
	// 			metadata: {
	// 				type: MemoryType.FRAGMENT,
	// 				position: 0,
	// 				timestamp: Date.now(),
	// 				// documentId is intentionally missing to test validation
	// 			} as FragmentMetadata, // Type assertion to FragmentMetadata
	// 		};

	// 		await expect(fragmentsManager.createMemory(noDocumentId)).rejects.toThrow(
	// 			"Fragment metadata must include documentId",
	// 		);

	// 		// Also test missing position
	// 		const noPosition: Memory = {
	// 			id: TEST_UUID_1,
	// 			entityId: TEST_UUID_2,
	// 			roomId: ROOM_UUID,
	// 			content: { text: "test" },
	// 			metadata: {
	// 				type: MemoryType.FRAGMENT,
	// 				documentId: TEST_UUID_1,
	// 				timestamp: Date.now(),
	// 				// position is intentionally missing to test validation
	// 			} as FragmentMetadata, // Type assertion to FragmentMetadata
	// 		};

	// 		await expect(fragmentsManager.createMemory(noPosition)).rejects.toThrow(
	// 			"Fragment metadata must include position",
	// 		);
	// 	});
	// });

	describe("Document Fragmentation", () => {
		it("should handle different token size configurations", async () => {
			const documentsManager = new MemoryManager({
				tableName: "documents",
				runtime: mockRuntime,
			});

			const largeText = "a".repeat(10000);
			const memory: Memory = {
				id: TEST_UUID_1,
				entityId: TEST_UUID_2,
				roomId: ROOM_UUID,
				content: { text: largeText },
				metadata: {
					type: MemoryType.DOCUMENT,
					timestamp: Date.now(),
				},
			};

			await documentsManager.createMemory(memory);
			// Verify fragments were created with correct sizes
		});

		it("should preserve semantic boundaries when possible", async () => {
			const _text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
			// Test that fragments break at paragraph boundaries
		});

		it("should handle multilingual content properly", async () => {
			const _multilingualText = "English text. 中文文本. Русский текст.";
			// Test proper handling of different scripts
		});
	});
});
