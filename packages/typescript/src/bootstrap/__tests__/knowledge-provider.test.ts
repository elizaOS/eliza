import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory } from "../../types/index.ts";
import { knowledgeProvider } from "../providers/knowledge.ts";
import {
	createTestMemory,
	createTestRuntime,
	createTestState,
} from "./test-utils.ts";

describe("knowledgeProvider", () => {
	let runtime: IAgentRuntime;

	beforeEach(async () => {
		runtime = await createTestRuntime();
		// Default mocks
		vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([]);
	});

	it("should return relevant knowledge based on recent message embeddings", async () => {
		const embedding = [0.1, 0.2, 0.3];
		const message = createTestMemory({
			content: { text: "Tell me about rockets" },
		});

		// Mock getMemories to return a recent message with embedding
		const recentMessage = createTestMemory({
			content: { text: "I like space" },
			embedding: embedding,
		});
		vi.spyOn(runtime, "getMemories").mockResolvedValue([recentMessage]);

		// Mock searchMemories to return a result
		const knowledgeItem: Memory = createTestMemory({
			id: "knowledge-1",
			content: { text: "Rockets are fast vehicles used for space travel." },
			metadata: { source: "manual" },
		});
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([knowledgeItem]);

		const result = await knowledgeProvider.get(
			runtime,
			message,
			createTestState(),
		);

		// Verify getMemories was called to fetch recent context
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				tableName: "messages",
				count: 5,
			}),
		);

		// Verify searchMemories was called with the embedding from recent message
		expect(runtime.searchMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				tableName: "knowledge",
				embedding: embedding,
				match_threshold: 0.75,
			}),
		);

		// Verify output contains the knowledge
		expect(result).toBeDefined();
		if (result && "text" in result) {
			expect(result.text).toContain("Rockets are fast vehicles");
		}
	});

	it("should return empty result when no recent embeddings found", async () => {
		const message = createTestMemory({
			content: { text: "Hello" },
		});

		// Mock getMemories to return messages WITHOUT embeddings
		const recentMessage = createTestMemory({
			content: { text: "Hi there" },
			embedding: undefined,
		});
		vi.spyOn(runtime, "getMemories").mockResolvedValue([recentMessage]);

		const result = await knowledgeProvider.get(
			runtime,
			message,
			createTestState(),
		);

		// Verify searchMemories was NOT called
		expect(runtime.searchMemories).not.toHaveBeenCalled();

		// Verify result is empty
		expect(result).toBeDefined();
		if (result && "text" in result) {
			expect(result.text).toBe("");
		}
	});

	it("should fallback to query text if provided in searchMemories options (hybrid search pattern)", async () => {
		// This validates that we are passing the query text to searchMemories
		// even though we use the embedding for vector search.
		const embedding = [0.9, 0.8, 0.7];
		const message = createTestMemory({
			content: { text: "What is quantum physics?" },
		});

		const recentMessage = createTestMemory({
			content: { text: "Previous context" },
			embedding: embedding,
		});
		vi.spyOn(runtime, "getMemories").mockResolvedValue([recentMessage]);

		await knowledgeProvider.get(runtime, message, createTestState());

		expect(runtime.searchMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "What is quantum physics?",
			}),
		);
	});
});
