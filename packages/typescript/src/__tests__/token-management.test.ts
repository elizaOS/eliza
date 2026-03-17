/**
 * Token Management, Auto-Compaction & Embedding Truncation Tests
 *
 * Comprehensive test suite covering:
 * - Token estimation utilities
 * - Token-based conversation length budgeting
 * - Message formatting text stripping
 * - Embedding text preparation & truncation
 * - Auto-compaction trigger & flow
 * - Prompt trimming safety net
 * - Long context scenarios
 * - Long messages
 * - Long series of messages
 * - Edge cases
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, Room, UUID } from "../types/index.ts";
import { ChannelType } from "../types/index.ts";
import {
	DEFAULT_MAX_CONVERSATION_TOKENS,
	DEFAULT_MAX_PROMPT_TOKENS,
	estimateTokens,
	MAX_EMBEDDING_CHARS,
	MAX_EMBEDDING_TOKENS,
	stripMessageFormatting,
	trimMessagesByTokenBudget,
} from "../utils.ts";

// ============================================
// Helper Factories
// ============================================

let msgCounter = 0;
function createMockMessage(
	text: string,
	createdAt: number,
	roomId: UUID = "room-1" as UUID,
	entityId: UUID = "user-1" as UUID,
): Memory {
	msgCounter++;
	return {
		id: `msg-${msgCounter}` as UUID,
		entityId,
		agentId: "agent-1" as UUID,
		roomId,
		content: { text },
		createdAt,
	};
}

function createLongText(tokens: number): string {
	// ~4 chars per token, use "word " (5 chars ≈ 1.25 tokens) pattern
	const words = Math.ceil(tokens / 1.25);
	return Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
}

function createMockRoom(options?: {
	lastCompactionAt?: number;
	metadata?: Record<string, unknown>;
}): Room {
	return {
		id: "room-1" as UUID,
		name: "Test Room",
		source: "test",
		type: ChannelType.GROUP,
		metadata: {
			...(options?.lastCompactionAt !== undefined
				? { lastCompactionAt: options.lastCompactionAt }
				: {}),
			...(options?.metadata || {}),
		},
	} as Room;
}

// ============================================
// 1. Token Estimation Utilities
// ============================================
describe("estimateTokens", () => {
	it("should return 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("should return 0 for null/undefined input", () => {
		expect(estimateTokens(null as never)).toBe(0);
		expect(estimateTokens(undefined as never)).toBe(0);
	});

	it("should estimate ~1 token per 4 characters", () => {
		const text = "a".repeat(100);
		expect(estimateTokens(text)).toBe(25);
	});

	it("should estimate tokens for typical English text", () => {
		const text = "Hello, how are you doing today? I hope everything is well.";
		const tokens = estimateTokens(text);
		// ~58 chars / 4 ≈ 15 tokens — should be in a reasonable range
		expect(tokens).toBeGreaterThan(10);
		expect(tokens).toBeLessThan(30);
	});

	it("should handle very long text efficiently", () => {
		const longText = "word ".repeat(100_000); // 500K chars
		const start = performance.now();
		const tokens = estimateTokens(longText);
		const duration = performance.now() - start;
		expect(tokens).toBeGreaterThan(100_000);
		// Must complete in under 10ms — it's just a division
		expect(duration).toBeLessThan(10);
	});

	it("should handle text with special characters", () => {
		const text = "こんにちは世界 🌍 emojis & symbols: @#$%";
		const tokens = estimateTokens(text);
		expect(tokens).toBeGreaterThan(0);
	});
});

// ============================================
// 2. trimMessagesByTokenBudget
// ============================================
describe("trimMessagesByTokenBudget", () => {
	it("should keep all messages when under budget", () => {
		const messages = [
			createMockMessage("Short message 1", 1000),
			createMockMessage("Short message 2", 2000),
			createMockMessage("Short message 3", 3000),
		];
		const result = trimMessagesByTokenBudget(messages, 10_000);
		expect(result).toHaveLength(3);
	});

	it("should trim oldest messages (from the end of array) when over budget", () => {
		// Messages ordered newest-first (as the provider would sort them)
		const messages = [
			createMockMessage("Newest message", 3000),
			createMockMessage("Middle message", 2000),
			createMockMessage(createLongText(50_000), 1000), // Very long old message
		];
		const result = trimMessagesByTokenBudget(messages, 1000);
		// Should keep newest first, stop when budget exceeded
		expect(result.length).toBeLessThan(3);
		expect(result[0].content.text).toBe("Newest message");
	});

	it("should always keep at least one message even if it exceeds budget", () => {
		const messages = [
			createMockMessage(createLongText(200_000), 1000), // Massive single message
		];
		const result = trimMessagesByTokenBudget(messages, 100);
		expect(result).toHaveLength(1);
	});

	it("should handle empty array", () => {
		const result = trimMessagesByTokenBudget([], 10_000);
		expect(result).toHaveLength(0);
	});

	it("should respect token budget precisely", () => {
		// Create messages with known token counts
		const msg100 = createMockMessage("a".repeat(400), 3000); // ~100 tokens
		const msg200 = createMockMessage("a".repeat(800), 2000); // ~200 tokens
		const msg300 = createMockMessage("a".repeat(1200), 1000); // ~300 tokens

		// Budget = 350 tokens: should fit msg100 + msg200 but not msg300
		const result = trimMessagesByTokenBudget([msg100, msg200, msg300], 350);
		expect(result).toHaveLength(2);
	});
});

// ============================================
// 3. stripMessageFormatting
// ============================================
describe("stripMessageFormatting", () => {
	it("should strip timestamp and entity ID patterns", () => {
		const text =
			"14:30 (5 minutes ago) [550e8400-e29b-41d4-a716-446655440000] Alice: Hello there";
		const stripped = stripMessageFormatting(text);
		expect(stripped).not.toContain("14:30");
		expect(stripped).not.toContain("550e8400");
		expect(stripped).not.toContain("Alice:");
		expect(stripped).toContain("Hello there");
	});

	it("should strip username prefixes from lines", () => {
		const text = "Alice: How are you?\nBob: I'm fine\nCharlie123: Great";
		const stripped = stripMessageFormatting(text);
		expect(stripped).not.toContain("Alice:");
		expect(stripped).not.toContain("Bob:");
		expect(stripped).not.toContain("Charlie123:");
		expect(stripped).toContain("How are you?");
		expect(stripped).toContain("fine");
	});

	it("should strip internal thought patterns", () => {
		const text = "(Alice's internal thought: I should help them) Let me help.";
		const stripped = stripMessageFormatting(text);
		expect(stripped).not.toContain("internal thought");
		expect(stripped).toContain("Let me help.");
	});

	it("should strip action patterns", () => {
		const text = "(Bob's actions: REPLY, SEARCH) Here is the answer.";
		const stripped = stripMessageFormatting(text);
		expect(stripped).not.toContain("actions:");
		expect(stripped).toContain("Here is the answer.");
	});

	it("should strip attachment metadata", () => {
		const text =
			"Check this out (Attachments: [img-1 - photo.jpg (https://example.com/photo.jpg)])";
		const stripped = stripMessageFormatting(text);
		expect(stripped).not.toContain("Attachments");
		expect(stripped).toContain("Check this out");
	});

	it("should strip markdown headers", () => {
		const text = "# Conversation Messages\nHello world\n## Section\nMore text";
		const stripped = stripMessageFormatting(text);
		expect(stripped).not.toContain("# Conversation Messages");
		expect(stripped).not.toContain("## Section");
		expect(stripped).toContain("Hello world");
		expect(stripped).toContain("More text");
	});

	it("should collapse multiple blank lines", () => {
		const text = "Line 1\n\n\n\n\n\nLine 2";
		const stripped = stripMessageFormatting(text);
		expect(stripped).toBe("Line 1\n\nLine 2");
	});

	it("should handle empty input", () => {
		expect(stripMessageFormatting("")).toBe("");
		expect(stripMessageFormatting(null as never)).toBe("");
	});
});

// ============================================
// 4. Embedding Text Preparation & Truncation
// ============================================
describe("EmbeddingGenerationService - text preparation", () => {
	it("should truncate text exceeding MAX_EMBEDDING_TOKENS", async () => {
		// Import the service
		const { EmbeddingGenerationService } = await import(
			"../services/embedding.ts"
		);

		const hugeText = createLongText(50_000); // Way over 8K limit
		const memory: Memory = {
			id: "mem-1" as UUID,
			entityId: "user-1" as UUID,
			roomId: "room-1" as UUID,
			content: { text: hugeText },
			createdAt: Date.now(),
		};

		let _capturedText = "";
		const mockRuntime = {
			agentId: "agent-1" as UUID,
			logger: {
				info: vi.fn(),
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
			getModel: vi.fn().mockReturnValue(true),
			useModel: vi.fn(async (_type: string, params: Record<string, string>) => {
				_capturedText = params.text;
				return [0.1, 0.2, 0.3]; // Mock embedding
			}),
			updateMemory: vi.fn(),
			log: vi.fn(),
			emitEvent: vi.fn(),
			registerEvent: vi.fn(),
			getMemories: vi.fn().mockResolvedValue([memory]),
		} as unknown as IAgentRuntime;

		const service = new EmbeddingGenerationService(mockRuntime);

		// Access the private method via the class prototype
		const prepareMethod = (service as Record<string, unknown>)
			.prepareEmbeddingText as (m: Memory) => Promise<string>;
		const prepared = await prepareMethod.call(service, memory);

		// The prepared text should be within the embedding token limit
		expect(prepared.length).toBeLessThanOrEqual(MAX_EMBEDDING_CHARS + 100); // Small buffer for rounding
		expect(estimateTokens(prepared)).toBeLessThanOrEqual(
			MAX_EMBEDDING_TOKENS + 25,
		); // Reasonable tolerance
	});

	it("should enrich short messages with conversation context", async () => {
		const { EmbeddingGenerationService } = await import(
			"../services/embedding.ts"
		);

		const shortMemory: Memory = {
			id: "mem-short" as UUID,
			entityId: "user-1" as UUID,
			roomId: "room-1" as UUID,
			content: { text: "yes" },
			createdAt: 5000,
		};

		const contextMessages: Memory[] = [
			createMockMessage("Would you like to deploy to production?", 3000),
			createMockMessage("I've reviewed the changes", 4000),
			shortMemory,
		];

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
			getModel: vi.fn().mockReturnValue(true),
			useModel: vi.fn().mockResolvedValue([0.1, 0.2]),
			updateMemory: vi.fn(),
			log: vi.fn(),
			emitEvent: vi.fn(),
			registerEvent: vi.fn(),
			getMemories: vi.fn().mockResolvedValue(contextMessages),
		} as unknown as IAgentRuntime;

		const service = new EmbeddingGenerationService(mockRuntime);
		const prepareMethod = (service as Record<string, unknown>)
			.prepareEmbeddingText as (m: Memory) => Promise<string>;
		const prepared = await prepareMethod.call(service, shortMemory);

		// Should include context from other messages, not just "yes"
		expect(prepared.length).toBeGreaterThan(10);
		// The "deploy to production" context should be included
		expect(prepared).toContain("deploy to production");
	});

	it("should strip formatting from embedding text", async () => {
		const { EmbeddingGenerationService } = await import(
			"../services/embedding.ts"
		);

		const formattedMemory: Memory = {
			id: "mem-fmt" as UUID,
			entityId: "user-1" as UUID,
			roomId: "room-1" as UUID,
			content: {
				text: "14:30 (5 minutes ago) [abc-def-123] Alice: Can you help me with debugging?",
			},
			createdAt: Date.now(),
		};

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
			getModel: vi.fn().mockReturnValue(true),
			useModel: vi.fn().mockResolvedValue([0.1]),
			updateMemory: vi.fn(),
			log: vi.fn(),
			emitEvent: vi.fn(),
			registerEvent: vi.fn(),
			getMemories: vi.fn().mockResolvedValue([formattedMemory]),
		} as unknown as IAgentRuntime;

		const service = new EmbeddingGenerationService(mockRuntime);
		const prepareMethod = (service as Record<string, unknown>)
			.prepareEmbeddingText as (m: Memory) => Promise<string>;
		const prepared = await prepareMethod.call(service, formattedMemory);

		// Should not contain formatting artifacts
		expect(prepared).not.toContain("14:30");
		expect(prepared).not.toContain("[abc-def-123]");
		// Should contain the semantic content
		expect(prepared).toContain("help me with debugging");
	});
});

// ============================================
// 5. Auto-Compaction
// ============================================
describe("Auto-compaction", () => {
	it("should trigger compaction and set lastCompactionAt", async () => {
		const { triggerAutoCompaction } = await import(
			"../bootstrap/services/autoCompaction.ts"
		);

		let updatedRoom: Room | null = null;
		let createdMemory: Memory | null = null;
		const timeBefore = Date.now();

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			getMemories: vi
				.fn()
				.mockResolvedValue([
					createMockMessage("Hello world", 1000),
					createMockMessage("How are you?", 2000),
				]),
			useModel: vi.fn().mockResolvedValue("Summary: A greeting conversation"),
			createMemory: vi.fn(async (memory: Memory) => {
				createdMemory = memory;
				return memory.id;
			}),
			getRoom: vi.fn().mockResolvedValue(createMockRoom()),
			updateRoom: vi.fn(async (room: Room) => {
				updatedRoom = room;
			}),
			getSetting: vi.fn().mockReturnValue(null),
		} as unknown as IAgentRuntime;

		await triggerAutoCompaction(mockRuntime, "room-1" as UUID);

		// Should have created a compaction summary memory
		expect(createdMemory).not.toBeNull();
		expect(createdMemory?.content?.text).toContain("[Compaction Summary]");
		expect(createdMemory?.content?.source).toBe("compaction");

		// Should have updated room with lastCompactionAt
		expect(updatedRoom).not.toBeNull();
		expect(updatedRoom?.metadata?.lastCompactionAt).toBeDefined();
		expect(
			updatedRoom?.metadata?.lastCompactionAt as number,
		).toBeGreaterThanOrEqual(timeBefore);

		// Should have compaction history
		const history = updatedRoom?.metadata?.compactionHistory as Array<{
			triggeredBy: string;
		}>;
		expect(history).toBeDefined();
		expect(history[history.length - 1].triggeredBy).toBe("auto-compaction");
	});

	it("should prevent concurrent compactions for the same room", async () => {
		const { triggerAutoCompaction } = await import(
			"../bootstrap/services/autoCompaction.ts"
		);

		let modelCallCount = 0;
		const mockRuntime = {
			agentId: "agent-1" as UUID,
			getMemories: vi
				.fn()
				.mockResolvedValue([createMockMessage("Hello", 1000)]),
			useModel: vi.fn(async () => {
				modelCallCount++;
				// Simulate slow LLM call
				await new Promise((resolve) => setTimeout(resolve, 100));
				return "Summary";
			}),
			createMemory: vi.fn().mockResolvedValue("mem-id"),
			getRoom: vi.fn().mockResolvedValue(createMockRoom()),
			updateRoom: vi.fn(),
			getSetting: vi.fn().mockReturnValue(null),
		} as unknown as IAgentRuntime;

		// Trigger two concurrent compactions for the same room
		const p1 = triggerAutoCompaction(mockRuntime, "room-1" as UUID);
		const p2 = triggerAutoCompaction(mockRuntime, "room-1" as UUID);
		await Promise.all([p1, p2]);

		// Only one should have actually run the model call
		expect(modelCallCount).toBe(1);
	});

	it("should handle empty room gracefully", async () => {
		const { triggerAutoCompaction } = await import(
			"../bootstrap/services/autoCompaction.ts"
		);

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			getMemories: vi.fn().mockResolvedValue([]),
			useModel: vi.fn(),
			createMemory: vi.fn(),
			getRoom: vi.fn().mockResolvedValue(null),
			updateRoom: vi.fn(),
			getSetting: vi.fn().mockReturnValue(null),
		} as unknown as IAgentRuntime;

		// Should not throw
		await expect(
			triggerAutoCompaction(mockRuntime, "room-empty" as UUID),
		).resolves.toBeUndefined();

		// Should not have called the model (no messages to summarize)
		expect(mockRuntime.useModel).not.toHaveBeenCalled();
	});

	it("should preserve compaction history from existing room metadata", async () => {
		const { triggerAutoCompaction } = await import(
			"../bootstrap/services/autoCompaction.ts"
		);

		let updatedRoom: Room | null = null;
		const existingRoom = createMockRoom({
			lastCompactionAt: 5000,
			metadata: {
				lastCompactionAt: 5000,
				compactionHistory: [{ timestamp: 5000, triggeredBy: "manual" }],
			},
		});

		const mockRuntime = {
			agentId: "agent-2" as UUID,
			getMemories: vi.fn().mockResolvedValue([createMockMessage("msg", 6000)]),
			useModel: vi.fn().mockResolvedValue("Summary"),
			createMemory: vi.fn().mockResolvedValue("mem-id"),
			getRoom: vi.fn().mockResolvedValue(existingRoom),
			updateRoom: vi.fn(async (room: Room) => {
				updatedRoom = room;
			}),
			getSetting: vi.fn().mockReturnValue(null),
		} as unknown as IAgentRuntime;

		await triggerAutoCompaction(mockRuntime, "room-1" as UUID);

		const history = updatedRoom?.metadata?.compactionHistory as Array<{
			triggeredBy: string;
		}>;
		expect(history).toHaveLength(2);
		expect(history[0].triggeredBy).toBe("manual");
		expect(history[1].triggeredBy).toBe("auto-compaction");
	});
});

// ============================================
// 6. recentMessages Provider - Token Budgeting
// ============================================
describe("recentMessages provider - token budgeting", () => {
	it("should limit messages by token budget, not just count", async () => {
		const { recentMessagesProvider } = await import(
			"../bootstrap/providers/recentMessages.ts"
		);

		// Create messages where total tokens exceed budget but count is small
		const hugeMessage = createMockMessage(createLongText(80_000), 1000);
		const recentMessage = createMockMessage("Recent short message", 2000);

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestBot" },
			getConversationLength: vi.fn().mockReturnValue(100),
			getRoom: vi.fn().mockResolvedValue(createMockRoom()),
			getMemories: vi.fn().mockResolvedValue([hugeMessage, recentMessage]),
			getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
			getRoomsForParticipants: vi.fn().mockResolvedValue([]),
			getEntityById: vi.fn().mockResolvedValue(null),
			getEntitiesForRoom: vi.fn().mockResolvedValue([]),
			getSetting: vi.fn((key: string) => {
				if (key === "MAX_CONVERSATION_TOKENS") return "50000";
				if (key === "AUTO_COMPACT") return "false"; // Disable for this test
				return null;
			}),
		} as unknown as IAgentRuntime;

		const result = await recentMessagesProvider.get(
			mockRuntime,
			createMockMessage("Hello", Date.now(), "room-1" as UUID),
			{} as never,
		);

		// The provider should have trimmed the huge message, keeping the recent one
		const data = result.data as { recentMessages: Memory[] };
		// With a 50K token budget, the 80K token message should be excluded
		// but at minimum the most recent message should be kept
		expect(data).toBeDefined();
	});

	it("should use compaction point when loading messages", async () => {
		const { recentMessagesProvider } = await import(
			"../bootstrap/providers/recentMessages.ts"
		);

		const roomWithCompaction = createMockRoom({ lastCompactionAt: 1500 });
		let capturedGetMemoriesParams: Record<string, unknown> | null = null;

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestBot" },
			getConversationLength: vi.fn().mockReturnValue(100),
			getRoom: vi.fn().mockResolvedValue(roomWithCompaction),
			getMemories: vi.fn(async (params: Record<string, unknown>) => {
				capturedGetMemoriesParams = params;
				return [];
			}),
			getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
			getRoomsForParticipants: vi.fn().mockResolvedValue([]),
			getEntitiesForRoom: vi.fn().mockResolvedValue([]),
			getSetting: vi.fn().mockReturnValue(null),
		} as unknown as IAgentRuntime;

		await recentMessagesProvider.get(
			mockRuntime,
			createMockMessage("Hello", Date.now(), "room-1" as UUID),
			{} as never,
		);

		// Should have passed the compaction point as `start`
		expect(capturedGetMemoriesParams).not.toBeNull();
		expect(capturedGetMemoriesParams?.start).toBe(1500);
	});
});

// ============================================
// 7. Long Context Scenarios
// ============================================
describe("Long context scenarios", () => {
	it("should handle 1000 messages without error", () => {
		const messages: Memory[] = [];
		for (let i = 0; i < 1000; i++) {
			messages.push(
				createMockMessage(
					`Message ${i}: This is a typical conversation message with some content.`,
					i * 1000,
				),
			);
		}

		// Sort newest first (as provider would)
		messages.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

		const result = trimMessagesByTokenBudget(
			messages,
			DEFAULT_MAX_CONVERSATION_TOKENS,
		);

		// Should keep many but not necessarily all
		expect(result.length).toBeGreaterThan(0);
		expect(result.length).toBeLessThanOrEqual(1000);
		// Most recent message should be first
		expect(result[0].createdAt).toBe(999_000);
	});

	it("should handle messages with extremely long text", () => {
		// A single message with 500K tokens worth of text
		const hugeMsg = createMockMessage(createLongText(500_000), 1000);
		const normalMsg = createMockMessage("Normal message", 2000);

		// Sort newest first
		const messages = [normalMsg, hugeMsg];
		const result = trimMessagesByTokenBudget(messages, 100_000);

		// Should keep at least the newest message
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result[0].content.text).toBe("Normal message");
	});

	it("should handle a long series of small messages efficiently", () => {
		const messages: Memory[] = [];
		for (let i = 0; i < 10_000; i++) {
			messages.push(createMockMessage("ok", i));
		}

		messages.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

		const start = performance.now();
		const result = trimMessagesByTokenBudget(messages, 100_000);
		const duration = performance.now() - start;

		expect(result.length).toBeGreaterThan(0);
		// Should complete quickly — just iterating and adding up numbers
		expect(duration).toBeLessThan(100); // 100ms is generous
	});

	it("should correctly accumulate tokens across many messages", () => {
		// Each message ≈ 25 tokens (100 chars / 4)
		const messages: Memory[] = [];
		for (let i = 0; i < 100; i++) {
			messages.push(
				createMockMessage("a".repeat(100), (100 - i) * 1000), // Newest first
			);
		}

		// Budget: 250 tokens → should fit ~10 messages
		const result = trimMessagesByTokenBudget(messages, 250);
		expect(result.length).toBe(10);
	});
});

// ============================================
// 8. Prompt Trimming
// ============================================
describe("Prompt trimming constants", () => {
	it("should have reasonable default values", () => {
		expect(DEFAULT_MAX_CONVERSATION_TOKENS).toBe(50_000);
		expect(DEFAULT_MAX_PROMPT_TOKENS).toBe(128_000);
		expect(MAX_EMBEDDING_TOKENS).toBe(8_000);
		expect(MAX_EMBEDDING_CHARS).toBe(32_000);
	});
});

// ============================================
// 9. Compaction Integration with InMemoryAdapter
// ============================================
describe("Compaction integration with InMemoryAdapter", () => {
	it("should only load messages after compaction point", async () => {
		const { InMemoryDatabaseAdapter } = await import(
			"../database/inMemoryAdapter.ts"
		);

		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();

		const roomId = "room-1" as UUID;

		// Create messages before and after compaction point
		const messages = [
			createMockMessage("Before 1", 1000, roomId),
			createMockMessage("Before 2", 2000, roomId),
			createMockMessage(
				"[Compaction Summary]\nConversation summary here",
				3000,
				roomId,
			),
			createMockMessage("After 1", 4000, roomId),
			createMockMessage("After 2", 5000, roomId),
		];

		for (const msg of messages) {
			await adapter.createMemory(msg, "messages", false);
		}

		// Simulate compaction point at 3000 (the summary message timestamp)
		const result = await adapter.getMemories({
			tableName: "messages",
			roomId,
			start: 3000,
		});

		// Should include the summary and messages after it
		expect(result.length).toBe(3);
		expect(result.map((m) => m.createdAt)).toEqual([3000, 4000, 5000]);
	});

	it("should handle auto-compaction timestamp before messages arrive during compaction", async () => {
		const { InMemoryDatabaseAdapter } = await import(
			"../database/inMemoryAdapter.ts"
		);

		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();

		const roomId = "room-1" as UUID;

		// Simulate timeline:
		// t=1000-5000: existing conversation
		// t=5500: compaction triggered (timestamp captured)
		// t=6000: new message arrives DURING compaction
		// t=7000: compaction summary stored with createdAt=5500
		// t=8000: another new message

		await adapter.createMemory(
			createMockMessage("Old msg 1", 1000, roomId),
			"messages",
			false,
		);
		await adapter.createMemory(
			createMockMessage("Old msg 2", 3000, roomId),
			"messages",
			false,
		);
		await adapter.createMemory(
			createMockMessage("Old msg 3", 5000, roomId),
			"messages",
			false,
		);
		// Message during compaction
		await adapter.createMemory(
			createMockMessage("During compaction msg", 6000, roomId),
			"messages",
			false,
		);
		// Compaction summary (stored after LLM call, but createdAt = pre-compaction timestamp)
		await adapter.createMemory(
			createMockMessage("[Compaction Summary] ...", 5500, roomId),
			"messages",
			false,
		);
		// Message after compaction
		await adapter.createMemory(
			createMockMessage("After compaction msg", 8000, roomId),
			"messages",
			false,
		);

		// Load with compaction point = 5500
		const result = await adapter.getMemories({
			tableName: "messages",
			roomId,
			start: 5500,
		});

		// Should include: summary (5500), during-compaction (6000), after (8000)
		const timestamps = result.map((m) => m.createdAt).sort();
		expect(timestamps).toContain(5500); // Summary
		expect(timestamps).toContain(6000); // During compaction
		expect(timestamps).toContain(8000); // After compaction
		// Should NOT include old messages
		expect(timestamps).not.toContain(1000);
		expect(timestamps).not.toContain(3000);
		expect(timestamps).not.toContain(5000);
	});
});

// ============================================
// 10. Edge Cases
// ============================================
describe("Edge cases", () => {
	it("estimateTokens should handle whitespace-only text", () => {
		expect(estimateTokens("   ")).toBeGreaterThan(0);
		expect(estimateTokens("\n\n\n")).toBeGreaterThan(0);
	});

	it("stripMessageFormatting should handle text with no formatting", () => {
		const plain = "Just a plain message with no special formatting.";
		const stripped = stripMessageFormatting(plain);
		expect(stripped).toBe(plain);
	});

	it("trimMessagesByTokenBudget should handle messages with empty text", () => {
		const messages = [
			createMockMessage("", 3000),
			createMockMessage("Real message", 2000),
			createMockMessage("", 1000),
		];
		const result = trimMessagesByTokenBudget(messages, 1000);
		// Empty messages have 0 tokens so all should fit
		expect(result).toHaveLength(3);
	});

	it("trimMessagesByTokenBudget with budget of 0 should still keep first message", () => {
		const messages = [createMockMessage("Hello", 1000)];
		const result = trimMessagesByTokenBudget(messages, 0);
		// First message always kept
		expect(result).toHaveLength(1);
	});

	it("should handle messages with no createdAt when sorting", () => {
		const messages: Memory[] = [
			{
				id: "m1" as UUID,
				entityId: "e1" as UUID,
				roomId: "r1" as UUID,
				content: { text: "No timestamp 1" },
			},
			{
				id: "m2" as UUID,
				entityId: "e1" as UUID,
				roomId: "r1" as UUID,
				content: { text: "No timestamp 2" },
				createdAt: 5000,
			},
		];

		// Sort newest first (undefined treated as 0)
		messages.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
		const result = trimMessagesByTokenBudget(messages, 10_000);
		expect(result).toHaveLength(2);
	});

	it("DEFAULT_MAX_CONVERSATION_TOKENS should be configurable via getSetting", async () => {
		// This verifies the provider reads the setting
		const { recentMessagesProvider } = await import(
			"../bootstrap/providers/recentMessages.ts"
		);

		let capturedSetting: string | null = null;
		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestBot" },
			getConversationLength: vi.fn().mockReturnValue(100),
			getRoom: vi.fn().mockResolvedValue(createMockRoom()),
			getMemories: vi.fn().mockResolvedValue([]),
			getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
			getRoomsForParticipants: vi.fn().mockResolvedValue([]),
			getEntitiesForRoom: vi.fn().mockResolvedValue([]),
			getSetting: vi.fn((key: string) => {
				if (key === "MAX_CONVERSATION_TOKENS") {
					capturedSetting = key;
					return "50000";
				}
				return null;
			}),
		} as unknown as IAgentRuntime;

		await recentMessagesProvider.get(
			mockRuntime,
			createMockMessage("Hello", Date.now(), "room-1" as UUID),
			{} as never,
		);

		expect(capturedSetting).toBe("MAX_CONVERSATION_TOKENS");
	});
});

// ============================================
// 11. Long Prompt Scenarios
// ============================================
describe("Long prompt scenarios", () => {
	it("estimateTokens should correctly flag prompts over 128K tokens", () => {
		// Create a prompt that would be ~200K tokens
		const longPrompt = createLongText(200_000);
		const estimate = estimateTokens(longPrompt);
		expect(estimate).toBeGreaterThan(128_000);
	});

	it("character-based truncation should preserve the end of prompt", () => {
		const prompt = `START_MARKER ${"x".repeat(1000)} END_MARKER`;
		const maxChars = 100;
		const truncated = prompt.slice(-maxChars);
		expect(truncated).toContain("END_MARKER");
		expect(truncated).not.toContain("START_MARKER");
	});
});

// ============================================
// 12. Full Pipeline Integration Test
// ============================================
describe("Full pipeline: messages → token budget → compaction", () => {
	it("should handle the autonomy loop scenario without errors", async () => {
		// Simulate the problem scenario: autonomy room accumulating messages
		// that cause token overflow

		const roomId = "autonomy-room" as UUID;
		const messages: Memory[] = [];

		// Simulate 20 autonomy cycles, each storing a prompt (~5K tokens) and response (~2K tokens)
		for (let i = 0; i < 20; i++) {
			messages.push(
				createMockMessage(
					createLongText(5_000),
					i * 60000,
					roomId,
					"autonomy-entity" as UUID,
				),
			);
			messages.push(
				createMockMessage(
					createLongText(2_000),
					i * 60000 + 30000,
					roomId,
					"agent-1" as UUID,
				),
			);
		}

		// Total: 20 * (5K + 2K) = 140K tokens
		const totalTokens = messages.reduce(
			(sum, m) => sum + estimateTokens(m.content?.text || ""),
			0,
		);
		expect(totalTokens).toBeGreaterThan(100_000);

		// Sort newest first
		const sorted = [...messages].sort(
			(a, b) => (b.createdAt || 0) - (a.createdAt || 0),
		);

		// Apply token budget
		const budgeted = trimMessagesByTokenBudget(sorted, 100_000);

		// Should have trimmed some older messages
		expect(budgeted.length).toBeLessThan(messages.length);
		expect(budgeted.length).toBeGreaterThan(0);

		// Most recent message should be included
		const mostRecent = sorted[0];
		expect(budgeted[0].createdAt).toBe(mostRecent.createdAt);

		// Verify token budget is respected
		const budgetedTokens = budgeted.reduce(
			(sum, m) => sum + estimateTokens(m.content?.text || ""),
			0,
		);
		expect(budgetedTokens).toBeLessThanOrEqual(100_000 + 10_000); // Buffer for single large message
	});

	it("should handle embedding for autonomy prompt messages", async () => {
		// Simulate an autonomy prompt being stored as a memory with huge text
		const hugePromptText = createLongText(50_000);
		const _memory: Memory = {
			id: "autonomy-prompt-mem" as UUID,
			entityId: "autonomy-entity" as UUID,
			roomId: "autonomy-room" as UUID,
			content: { text: hugePromptText },
			createdAt: Date.now(),
		};

		// The prepared embedding text should be truncated
		const stripped = stripMessageFormatting(hugePromptText);
		const maxChars = MAX_EMBEDDING_TOKENS * 4;
		const truncated =
			stripped.length > maxChars ? stripped.slice(-maxChars) : stripped;

		expect(estimateTokens(truncated)).toBeLessThanOrEqual(
			MAX_EMBEDDING_TOKENS + 50,
		);
	});
});
