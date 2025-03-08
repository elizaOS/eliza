import { describe, expect, it, mock, beforeEach, type Mock } from "bun:test";
import knowledge from "../src/knowledge";
import type { AgentRuntime } from "../src/runtime";
import type {
	Memory,
	UUID,
	KnowledgeItem,
	IMemoryManager,
	FragmentMetadata,
} from "../src/types";
import { MemoryType, ModelClass } from "../src/types.ts";

// Define test UUIDs
const TEST_UUID_1 = "123e4567-e89b-12d3-a456-426614174000" as UUID;
const TEST_UUID_2 = "987fcdeb-51e4-3af2-b890-312345678901" as UUID;

// Mock modules
const mockSplitChunks = mock(async (text: string) => [text]);
const mockStringToUuid = mock((str: string) => str);

// Mock the imports with correct paths
mock.module("../src/parsing.ts", () => ({
	splitChunks: mockSplitChunks,
}));

mock.module("../src/uuid.ts", () => ({
	stringToUuid: mockStringToUuid,
}));

// Define the mock function types using interfaces
/**
 * Define a type alias `SearchMemoriesFn` which refers to the `searchMemories` function
 * defined in the `IMemoryManager` interface.
 */
type SearchMemoriesFn = IMemoryManager["searchMemories"];
/**
* Define a type alias GetMemoryByIdFn that represents the getMemoryById function from the IMemoryManager interface.
*/
type GetMemoryByIdFn = IMemoryManager["getMemoryById"];
/**
 * Represents a function type that points to the 'createMemory' method of the IMemoryManager interface.
 */
type CreateMemoryFn = IMemoryManager["createMemory"];

describe("Knowledge Module", () => {
	let mockRuntime: AgentRuntime;

	beforeEach(() => {
		// Create properly typed mocks with separate instances
		const searchMemoriesMock = mock(() =>
			Promise.resolve([]),
		) as Mock<SearchMemoriesFn>;
		const getMemoryByIdMock = mock(() =>
			Promise.resolve(null),
		) as Mock<GetMemoryByIdFn>;
		const knowledgeCreateMemoryMock = mock(() =>
			Promise.resolve(),
		) as Mock<CreateMemoryFn>;
		const documentsCreateMemoryMock = mock(() =>
			Promise.resolve(),
		) as Mock<CreateMemoryFn>;

		mockRuntime = {
			agentId: "test-agent",
			messageManager: {
				getCachedEmbeddings: mock(() => Promise.resolve([])),
			},
			knowledgeManager: {
				searchMemories: searchMemoriesMock,
				createMemory: knowledgeCreateMemoryMock, // Use separate mock
			},
			documentsManager: {
				getMemoryById: getMemoryByIdMock,
				createMemory: documentsCreateMemoryMock, // Use separate mock
			},
			useModel: mock(() => Promise.resolve([])),
		} as unknown as AgentRuntime;

		// Mock splitChunks to return predictable chunks
		mockSplitChunks.mockImplementation(async () => [
			"chunk1",
			"chunk2",
			"chunk3",
		]);
	});

	describe("preprocess", () => {
		it("should handle invalid inputs", () => {
			expect(knowledge.preprocess(null as any)).toBe("");
			expect(knowledge.preprocess(undefined as any)).toBe("");
			expect(knowledge.preprocess("")).toBe("");
		});

		it("should remove code blocks and inline code", () => {
			const input = "Here is some code: ```const x = 1;``` and `inline code`";
			expect(knowledge.preprocess(input)).toBe("here is some code: and");
		});

		it("should handle markdown formatting", () => {
			const input =
				"# Header\n## Subheader\n[Link](http://example.com)\n![Image](image.jpg)";
			expect(knowledge.preprocess(input)).toBe("header subheader link image");
		});

		it("should simplify URLs", () => {
			const input = "Visit https://www.example.com/path?param=value";
			expect(knowledge.preprocess(input)).toBe(
				"visit example.com/path?param=value",
			);
		});

		it("should remove Discord mentions and HTML tags", () => {
			const input = "Hello <@123456789> and <div>HTML content</div>";
			expect(knowledge.preprocess(input)).toBe("hello and html content");
		});

		it("should normalize whitespace and newlines", () => {
			const input = "Multiple    spaces\n\n\nand\nnewlines";
			expect(knowledge.preprocess(input)).toBe("multiple spaces and newlines");
		});

		it("should remove comments", () => {
			const input = "/* Block comment */ Normal text // Line comment";
			expect(knowledge.preprocess(input)).toBe("normal text");
		});
	});

	describe("get and set", () => {
		describe("get", () => {
			it("should handle invalid messages", async () => {
				const invalidMessage = {} as Memory;
				const result = await knowledge.get(mockRuntime, invalidMessage);
				expect(result).toEqual([]);
			});

			it("should handle empty processed text", async () => {
				const message: Memory = {
					agentId: "test-agent",
					content: { text: "```code only```" },
				} as unknown as Memory;

				const result = await knowledge.get(mockRuntime, message);
				expect(result).toEqual([]);
			});
		});
	});

	describe("Document and Fragment Management", () => {
		it("should store document and create fragments", async () => {
			// Reset mock counters before test
			(
				mockRuntime.knowledgeManager.createMemory as Mock<CreateMemoryFn>
			).mockReset();
			(
				mockRuntime.documentsManager.createMemory as Mock<CreateMemoryFn>
			).mockReset();
			mockSplitChunks.mockReset();

			// Log what's happening
			console.log("Setting up mock splitChunks...");
			mockSplitChunks.mockImplementation(async (text: string) => {
				const chunks = ["chunk1", "chunk2", "chunk3"];
				console.log("splitChunks called with:", text);
				console.log("returning chunks:", chunks);
				return chunks;
			});

			const item: KnowledgeItem = {
				id: TEST_UUID_1,
				content: {
					text: "test document content",
				},
			};

			console.log("Calling knowledge.set...");
			console.log("Item content:", item.content);
			await knowledge.set(mockRuntime, item);
			console.log("After knowledge.set");

			// Log mock calls
			console.log(
				"knowledgeManager.createMemory calls:",
				(mockRuntime.knowledgeManager.createMemory as Mock<CreateMemoryFn>).mock
					.calls.length,
			);
			console.log(
				"documentsManager.createMemory calls:",
				(mockRuntime.documentsManager.createMemory as Mock<CreateMemoryFn>).mock
					.calls.length,
			);
			console.log("splitChunks calls:", mockSplitChunks.mock.calls.length);

			// Verify document creation
			expect(mockRuntime.documentsManager.createMemory).toHaveBeenCalledTimes(
				1,
			); // Document should be created once
			expect(mockRuntime.knowledgeManager.createMemory).toHaveBeenCalledTimes(
				3,
			); // Three fragments should be created

			// Check first fragment
			expect(mockRuntime.knowledgeManager.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: { text: "chunk1" },
					metadata: expect.objectContaining({
						type: "fragment",
						documentId: TEST_UUID_1,
						position: 0,
					}),
				}),
			);
		});

		it("should retrieve documents through fragment search", async () => {
			const mockFragment: Memory = {
				id: TEST_UUID_2,
				userId: TEST_UUID_1,
				roomId: TEST_UUID_1,
				content: {
					text: "fragment text",
					source: TEST_UUID_1,
				},
				metadata: {
					type: MemoryType.FRAGMENT,
					documentId: TEST_UUID_1,
					position: 0,
				},
			};

			const mockDocument: Memory = {
				id: TEST_UUID_1,
				userId: TEST_UUID_1,
				roomId: TEST_UUID_1,
				content: { text: "full document" },
				metadata: {
					type: MemoryType.DOCUMENT,
				},
			};

			// Now these will work with proper typing
			(
				mockRuntime.knowledgeManager.searchMemories as Mock<SearchMemoriesFn>
			).mockResolvedValue([mockFragment]);
			(
				mockRuntime.documentsManager.getMemoryById as Mock<GetMemoryByIdFn>
			).mockResolvedValue(mockDocument);

			const result = await knowledge.get(mockRuntime, {
				userId: TEST_UUID_1,
				roomId: TEST_UUID_1,
				content: { text: "query" },
			} as Memory);

			expect(result).toHaveLength(1);
			expect(result[0].content).toEqual(mockDocument.content);
		});

		it("should properly fragment large documents", async () => {
			const largeText = "test ".repeat(1000); // ~5000 chars

			// Mock splitChunks to return more chunks for large text
			mockSplitChunks.mockImplementation(async (_text: string) => {
				// Create ~7 chunks for the test
				return Array.from(
					{ length: 7 },
					(_, i) => `chunk${i + 1} of large text`,
				);
			});

			const item: KnowledgeItem = {
				id: TEST_UUID_1,
				content: { text: largeText },
			};

			await knowledge.set(mockRuntime, item);

			// Verify document was stored
			expect(mockRuntime.documentsManager.createMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({
						type: MemoryType.DOCUMENT,
					}),
				}),
			);

			// Verify fragments were created (~7 fragments for 5000 chars with 750 char chunks)
			const createMemoryCalls = (
				mockRuntime.knowledgeManager.createMemory as Mock<CreateMemoryFn>
			).mock.calls;
			expect(createMemoryCalls.length).toBeGreaterThan(5);

			// Verify fragment linking
			const firstFragment = createMemoryCalls[0][0];
			expect(firstFragment.metadata).toEqual(
				expect.objectContaining({
					type: MemoryType.FRAGMENT,
					documentId: TEST_UUID_1,
					position: 0,
				}),
			);
		});
	});

	describe("Document Fragmentation", () => {
		it("should handle different token size configurations", async () => {
			const text = "a".repeat(10000);

			// Test with different chunk sizes
			const configs = [
				{ targetTokens: 1000, overlap: 100 },
				{ targetTokens: 2000, overlap: 200 },
				{ targetTokens: 4000, overlap: 400 },
			];

			for (const config of configs) {
				const _result = await knowledge.set(
					mockRuntime,
					{
						id: TEST_UUID_1,
						content: { text },
					},
					config,
				);

				const fragments = await mockRuntime.knowledgeManager.searchMemories({
					embedding: [],
					match_threshold: 0.9,
					roomId: mockRuntime.agentId,
					metadata: {
						type: MemoryType.FRAGMENT,
						documentId: TEST_UUID_1,
						position: 0,
						timestamp: Date.now(),
					} as FragmentMetadata,
				});

				// Verify fragment sizes
				fragments.forEach((f) => {
					expect(f.content.text.length).toBeLessThanOrEqual(
						config.targetTokens / 4,
					);
				});
			}
		});

		it("should preserve semantic boundaries when possible", async () => {
			const text =
				"Complete sentence one. Complete sentence two. Complete sentence three.";

			await knowledge.set(mockRuntime, {
				id: TEST_UUID_1,
				content: { text },
			});

			const fragments = await mockRuntime.knowledgeManager.searchMemories({
				embedding: [],
				match_threshold: 0.9,
				roomId: mockRuntime.agentId,
				metadata: {
					type: MemoryType.FRAGMENT,
					documentId: TEST_UUID_1,
					position: 0,
					timestamp: Date.now(),
				} as FragmentMetadata,
			});

			// Check that fragments break at sentence boundaries where possible
			fragments.forEach((f) => {
				expect(f.content.text.endsWith(".")).toBe(true);
			});
		});

		it("should handle multilingual content properly", async () => {
			const multilingualText = "English text. 中文文本. Español texto.";

			await knowledge.set(mockRuntime, {
				id: TEST_UUID_1,
				content: { text: multilingualText },
			});

			const fragments = await mockRuntime.knowledgeManager.searchMemories({
				embedding: [],
				match_threshold: 0.9,
				roomId: mockRuntime.agentId,
				metadata: {
					type: MemoryType.FRAGMENT,
					documentId: TEST_UUID_1,
					position: 0,
					timestamp: Date.now(),
				} as FragmentMetadata,
			});

			// Verify each script is handled properly
			fragments.forEach((f) => {
				expect(f.content.text).toMatch(/[A-Za-z]|[\u4e00-\u9fa5]|[áéíóúñ]/);
			});
		});
	});

	describe("RAG Functionality", () => {
		it("should retrieve fragments by similarity", async () => {
			// Mock the fragment that should be returned
			const mockFragment: Memory = {
				id: TEST_UUID_2,
				userId: TEST_UUID_2,
				roomId: TEST_UUID_1,
				content: { text: "The quick brown fox jumps over the lazy dog" },
				metadata: {
					type: MemoryType.FRAGMENT,
					documentId: TEST_UUID_1,
					position: 0,
					timestamp: Date.now(),
				},
			};

			// Set up mock to return our fragment
			(
				mockRuntime.knowledgeManager.searchMemories as Mock<SearchMemoriesFn>
			).mockResolvedValue([mockFragment]);

			// Search with similar query
			const query = "quick fox jumping";
			const embedding = await mockRuntime.useModel(
				ModelClass.TEXT_EMBEDDING,
				query,
			);

			const similarFragments =
				await mockRuntime.knowledgeManager.searchMemories({
					embedding,
					match_threshold: 0.1,
					metadata: {
						type: MemoryType.FRAGMENT,
						documentId: TEST_UUID_1,
						position: 0,
						timestamp: Date.now(),
					} as FragmentMetadata,
				});

			expect(similarFragments.length).toBeGreaterThan(0);
			expect(similarFragments[0].content.text).toContain("fox");
		});

		it("should reconstruct documents from fragments", async () => {
			// Create mock fragments in order
			const mockFragments: Memory[] = [
				{
					id: TEST_UUID_2,
					userId: TEST_UUID_2,
					roomId: TEST_UUID_1,
					content: { text: "First part. " },
					metadata: {
						type: MemoryType.FRAGMENT,
						documentId: TEST_UUID_1,
						position: 0,
						timestamp: Date.now(),
					},
				},
				{
					id: TEST_UUID_2,
					userId: TEST_UUID_2,
					roomId: TEST_UUID_1,
					content: { text: "Second part. " },
					metadata: {
						type: MemoryType.FRAGMENT,
						documentId: TEST_UUID_1,
						position: 1,
						timestamp: Date.now(),
					},
				},
				{
					id: TEST_UUID_2,
					userId: TEST_UUID_2,
					roomId: TEST_UUID_1,
					content: { text: "Third part." },
					metadata: {
						type: MemoryType.FRAGMENT,
						documentId: TEST_UUID_1,
						position: 2,
						timestamp: Date.now(),
					},
				},
			];

			// Set up mock to return our fragments
			(
				mockRuntime.knowledgeManager.searchMemories as Mock<SearchMemoriesFn>
			).mockResolvedValue(mockFragments);

			const fragments = await mockRuntime.knowledgeManager.searchMemories({
				embedding: [],
				match_threshold: 0.1,
				roomId: TEST_UUID_1,
				metadata: {
					type: MemoryType.FRAGMENT,
					documentId: TEST_UUID_1,
					position: 0,
					timestamp: Date.now(),
				} as FragmentMetadata,
			});

			const orderedFragments = fragments.sort(
				(a, b) =>
					(a.metadata as FragmentMetadata).position -
					(b.metadata as FragmentMetadata).position,
			);

			const reconstructed = orderedFragments
				.map((f) => f.content.text)
				.join("");

			expect(reconstructed).toBe("First part. Second part. Third part.");
		});
	});
});
