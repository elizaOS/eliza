import { composeContext } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reflectionEvaluator } from "../../src/evaluators/reflection";

vi.mock("@elizaos/core", () => ({
	composeContext: vi.fn(),
	MemoryManager: vi.fn().mockImplementation((_config: any) => ({
		getMemoriesByEvaluator: vi.fn().mockResolvedValue([]),
		addMemory: vi.fn().mockResolvedValue(true),
		addEmbeddingToMemory: vi.fn().mockResolvedValue({
			id: "test-memory-id",
			content: {
				text: "Test memory content",
			},
		}),
		createMemory: vi.fn().mockResolvedValue({
			id: "test-memory-id",
			content: {
				text: "Test memory content",
			},
		}),
	})),
	ModelClass: {
		SMALL: "small",
	},
}));

describe("reflectionEvaluator", () => {
	let mockRuntime;
	let mockMessage;

	beforeEach(() => {
		mockRuntime = {
			character: {
				settings: {},
			},
			messageManager: {
				countMemories: vi.fn().mockResolvedValue(5),
			},
			composeState: vi.fn().mockResolvedValue({
				agentId: "test-agent",
				roomId: "test-room",
			}),
			getConversationLength: vi.fn().mockReturnValue(10),
		};

		mockMessage = {
			content: {
				text: "I live in New York and work as a software engineer.",
			},
			roomId: "test-room",
		};

		// Reset all mocks
		vi.clearAllMocks();
	});

	describe("validation", () => {
		it("should validate successfully", async () => {
			const result = await reflectionEvaluator.validate(
				mockRuntime,
				mockMessage,
			);
			expect(result).toBe(true);
			expect(mockRuntime.messageManager.countMemories).toHaveBeenCalledWith(
				"test-room",
			);
			expect(mockRuntime.getConversationLength).toHaveBeenCalled();
		});
	});

	describe("evaluator properties", () => {
		it("should have correct evaluator properties", () => {
			expect(reflectionEvaluator.name).toBe("GET_FACTS");
			expect(reflectionEvaluator.similes).toContain("GET_CLAIMS");
			expect(reflectionEvaluator.description).toBeDefined();
			expect(reflectionEvaluator.description).toContain(
				"Extract factual information",
			);
			expect(reflectionEvaluator.examples).toBeDefined();
			expect(Array.isArray(reflectionEvaluator.examples)).toBe(true);
		});

		it("should have valid examples", () => {
			reflectionEvaluator.examples.forEach((example) => {
				expect(example).toBeDefined();
				// will add  more specific example validations based on the example structure
			});
		});
	});

	describe("fact extraction", () => {
		it("should handle fact extraction", async () => {
			const _mockFacts = [
				{
					claim: "User lives in New York",
					type: "fact",
					in_bio: false,
					already_known: false,
				},
				{
					claim: "User works as a software engineer",
					type: "fact",
					in_bio: false,
					already_known: false,
				},
			];

			vi.mocked(composeContext).mockReturnValue("mock-context");

			const result = await reflectionEvaluator.handler(
				mockRuntime,
				mockMessage,
			);

			expect(composeContext).toHaveBeenCalled();
			expect(result).toBeDefined();
		});
	});
});
