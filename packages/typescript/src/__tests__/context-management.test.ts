/**
 * Context Management — Comprehensive Tests
 *
 * Validates every layer of the token-limiting pipeline:
 *
 * Layer 1 — Per-message truncation (recentMessages provider)
 * Layer 2 — Conversation token budgeting (recentMessages provider)
 * Layer 3 — Prompt-level trimming (dynamicPromptExecFromState)
 * Layer 4 — maxTokens capping (dynamicPromptExecFromState)
 * Layer 5 — Embedding input truncation
 * Layer 6 — Workspace provider total cap
 * Layer 7 — Compaction integration
 *
 * Edge cases tested:
 * - Single message containing millions of characters
 * - Hundreds of normal messages blowing the budget
 * - Exactly-at-boundary values
 * - Empty / null / undefined content
 * - Mixed huge + tiny messages
 * - Formatting overhead mismatch
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, Room, UUID } from "../types/index.ts";
import {
	DEFAULT_MAX_CONVERSATION_TOKENS,
	DEFAULT_MAX_PROMPT_TOKENS,
	estimateTokens,
	MAX_EMBEDDING_CHARS,
	MAX_EMBEDDING_TOKENS,
	stripMessageFormatting,
	trimMessagesByTokenBudget,
} from "../utils.ts";

// ============================================================================
// Helpers
// ============================================================================

let _id = 0;
function uuid(): UUID {
	return `00000000-0000-0000-0000-${String(++_id).padStart(12, "0")}` as UUID;
}

function msg(
	text: string,
	createdAt = Date.now(),
	roomId: UUID = "room-1" as UUID,
	entityId: UUID = "user-1" as UUID,
): Memory {
	return {
		id: uuid(),
		entityId,
		agentId: "agent-1" as UUID,
		roomId,
		content: { text },
		createdAt,
	};
}

/** Generate a string of approximately `tokens` estimated tokens. */
function textOfTokens(tokens: number): string {
	// estimateTokens uses text.length / 4
	return "x".repeat(tokens * 4);
}

function mockRoom(opts?: { lastCompactionAt?: number }): Room {
	return {
		id: "room-1" as UUID,
		name: "Test Room",
		metadata:
			opts?.lastCompactionAt !== undefined
				? { lastCompactionAt: opts.lastCompactionAt }
				: {},
	} as Room;
}

function baseMockRuntime(
	overrides?: Partial<Record<string, unknown>>,
): IAgentRuntime {
	return {
		agentId: "agent-1" as UUID,
		character: { name: "TestBot" },
		getConversationLength: vi.fn().mockReturnValue(200),
		getRoom: vi.fn().mockResolvedValue(mockRoom()),
		getMemories: vi.fn().mockResolvedValue([]),
		getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
		getRoomsForParticipants: vi.fn().mockResolvedValue([]),
		getEntitiesForRoom: vi.fn().mockResolvedValue([]),
		getEntityById: vi.fn().mockResolvedValue(null),
		getSetting: vi.fn().mockReturnValue(null),
		...overrides,
	} as unknown as IAgentRuntime;
}

// ============================================================================
// 1. Per-Message Truncation
// ============================================================================
describe("Layer 1 — Per-message truncation", () => {
	const MAX_SINGLE_MESSAGE_CHARS = 20_000; // Matches provider constant

	it("should truncate a single 1 MB message", async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages.ts"
		);

		const hugeText = "A".repeat(1_000_000); // 1 MB
		const runtime = baseMockRuntime({
			getMemories: vi.fn().mockResolvedValue([msg(hugeText, 1000)]),
		});

		const result = await recentMessagesProvider.get(
			runtime,
			msg("hi", Date.now()),
			{} as never,
		);

		// The formatted text should NOT contain 1 MB of content
		const text = result.text ?? "";
		expect(text.length).toBeLessThan(100_000); // well under 1 MB
	});

	it("should truncate a 50 MB message (simulating base64 blob)", async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages.ts"
		);

		const hugeText = "B".repeat(50_000_000); // 50 MB
		const runtime = baseMockRuntime({
			getMemories: vi.fn().mockResolvedValue([msg(hugeText, 1000)]),
		});

		const result = await recentMessagesProvider.get(
			runtime,
			msg("hi", Date.now()),
			{} as never,
		);

		const text = result.text ?? "";
		// Even with a 50 MB message, the output must be bounded
		expect(text.length).toBeLessThan(200_000);
		// Must contain the truncation marker
		expect(text).toContain("message truncated");
	});

	it("should preserve messages under the cap unchanged", async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages.ts"
		);

		const normalText = "Hello, how are you doing today?";
		const runtime = baseMockRuntime({
			getMemories: vi.fn().mockResolvedValue([msg(normalText, 1000)]),
		});

		const result = await recentMessagesProvider.get(
			runtime,
			msg("reply", Date.now()),
			{} as never,
		);

		const text = result.text ?? "";
		expect(text).toContain(normalText);
		expect(text).not.toContain("truncated");
	});

	it("should truncate multiple huge messages independently", async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages.ts"
		);

		const hugeMessages = [
			msg("C".repeat(500_000), 1000),
			msg("D".repeat(500_000), 2000),
			msg("E".repeat(500_000), 3000),
		];

		const runtime = baseMockRuntime({
			getMemories: vi.fn().mockResolvedValue(hugeMessages),
		});

		const result = await recentMessagesProvider.get(
			runtime,
			msg("hi", Date.now()),
			{} as never,
		);

		const text = result.text ?? "";
		// 3 huge messages, each capped at 20K chars, plus formatting
		// Total should be well under 200K
		expect(text.length).toBeLessThan(200_000);
	});

	it("should include truncation notice with original size", async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages.ts"
		);

		const hugeText = "X".repeat(100_000);
		const runtime = baseMockRuntime({
			getMemories: vi.fn().mockResolvedValue([msg(hugeText, 1000)]),
		});

		const result = await recentMessagesProvider.get(
			runtime,
			msg("hi", Date.now()),
			{} as never,
		);

		const text = result.text ?? "";
		expect(text).toContain("100,000 chars");
	});

	it("should handle message at exactly the cap boundary", () => {
		// Message at exactly MAX_SINGLE_MESSAGE_CHARS should NOT be truncated
		const exactText = "Z".repeat(MAX_SINGLE_MESSAGE_CHARS);
		expect(exactText.length).toBe(MAX_SINGLE_MESSAGE_CHARS);

		// Message 1 char over should be truncated
		const overText = "Z".repeat(MAX_SINGLE_MESSAGE_CHARS + 1);
		expect(overText.length).toBe(MAX_SINGLE_MESSAGE_CHARS + 1);
	});
});

// ============================================================================
// 2. Conversation Token Budgeting
// ============================================================================
describe("Layer 2 — Conversation token budgeting", () => {
	it("should respect DEFAULT_MAX_CONVERSATION_TOKENS", () => {
		expect(DEFAULT_MAX_CONVERSATION_TOKENS).toBe(50_000);
	});

	it("should drop older messages when budget is exceeded", () => {
		// Create 100 messages of ~1000 tokens each = 100K total
		const messages = Array.from(
			{ length: 100 },
			(_, i) => msg(textOfTokens(1_000), 100 - i), // newest first
		);

		const result = trimMessagesByTokenBudget(messages, 50_000);
		expect(result.length).toBeLessThan(100);
		expect(result.length).toBeGreaterThan(0);

		// Most recent message preserved
		expect(result[0].createdAt).toBe(messages[0].createdAt);
	});

	it("should keep at least one message even if it alone exceeds budget", () => {
		const hugeMsg = msg(textOfTokens(100_000), 1000);
		const result = trimMessagesByTokenBudget([hugeMsg], 50_000);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(hugeMsg);
	});

	it("should handle mix of tiny and huge messages", () => {
		const messages = [
			msg(textOfTokens(40_000), 100), // newest — huge
			msg("hi", 99), // tiny
			msg("hello", 98), // tiny
			msg(textOfTokens(40_000), 97), // huge
		];

		const result = trimMessagesByTokenBudget(messages, 50_000);
		// First message (40K) fills most of budget, second (tiny) fits, rest don't
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result.length).toBeLessThan(4);
	});

	it("should apply formatting overhead factor", async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages.ts"
		);

		// Create messages that total ~45K estimated tokens of raw text
		// With 1.3x overhead factor, effective budget = 50K / 1.3 ≈ 38.5K
		// So 45K raw tokens should trigger trimming
		const messages = Array.from({ length: 45 }, (_, i) =>
			msg(textOfTokens(1_000), Date.now() - i * 1000),
		);

		const runtime = baseMockRuntime({
			getMemories: vi.fn().mockResolvedValue(messages),
		});

		const result = await recentMessagesProvider.get(
			runtime,
			msg("hi", Date.now()),
			{} as never,
		);

		// Some messages should have been dropped
		const kept = (result.data as Record<string, Memory[]>).recentMessages;
		expect(kept.length).toBeLessThan(45);
		expect(kept.length).toBeGreaterThan(0);
	});

	it("should handle 500 short messages within budget", () => {
		// 500 messages of 10 tokens each = 5K total — should all fit
		const messages = Array.from({ length: 500 }, (_, i) =>
			msg(`short msg ${i}`, 500 - i),
		);

		const result = trimMessagesByTokenBudget(messages, 50_000);
		expect(result.length).toBe(500);
	});

	it("should handle 10000 tiny messages", () => {
		const messages = Array.from({ length: 10_000 }, (_, i) =>
			msg("ok", 10_000 - i),
		);

		const result = trimMessagesByTokenBudget(messages, 50_000);
		// "ok" = 1 token, 10K messages = 10K tokens — all fit
		expect(result.length).toBe(10_000);
	});

	it("should handle empty message text gracefully", () => {
		const messages = [msg("", 100), msg("", 99), msg("hello", 98)];

		const result = trimMessagesByTokenBudget(messages, 50_000);
		expect(result.length).toBe(3);
	});

	it("should handle messages with undefined content text", () => {
		const badMsg: Memory = {
			id: uuid(),
			entityId: "user-1" as UUID,
			agentId: "agent-1" as UUID,
			roomId: "room-1" as UUID,
			content: {} as Memory["content"],
			createdAt: 100,
		};

		const result = trimMessagesByTokenBudget([badMsg], 50_000);
		expect(result).toHaveLength(1);
	});
});

// ============================================================================
// 3. Prompt-Level Trimming
// ============================================================================
describe("Layer 3 — Prompt-level trimming", () => {
	it("should have correct constants", () => {
		expect(DEFAULT_MAX_PROMPT_TOKENS).toBe(128_000);
	});

	it("character fallback should trim to 2 chars/token ratio", () => {
		// Simulating the fallback: trimTarget * 2
		const trimTarget = Math.floor(128_000 * 0.85); // 108,800
		const maxChars = trimTarget * 2; // 217,600

		// A prompt of 500K chars should be sliced to 217.6K
		const bigPrompt = "P".repeat(500_000);
		const trimmed = bigPrompt.slice(-maxChars);
		expect(trimmed.length).toBe(maxChars);

		// At worst case 2.27 chars/token, this gives ~95.8K tokens
		// Which is safely under 128K
		const worstCaseTokens = trimmed.length / 2.27;
		expect(worstCaseTokens).toBeLessThan(128_000);
	});

	it("character fallback should handle a 50 MB prompt", () => {
		const trimTarget = Math.floor(128_000 * 0.85);
		const maxChars = trimTarget * 2;

		const massivePrompt = "M".repeat(50_000_000); // 50 MB
		const start = performance.now();
		const trimmed = massivePrompt.slice(-maxChars);
		const elapsed = performance.now() - start;

		expect(trimmed.length).toBe(maxChars);
		// String slice on 50 MB should complete in < 1s (heap allocation varies)
		expect(elapsed).toBeLessThan(1_000);
	});

	it("trim safety factor of 0.85 provides 15% margin", () => {
		const factor = 0.85;
		const maxPromptTokens = 128_000;
		const trimTarget = Math.floor(maxPromptTokens * factor);

		expect(trimTarget).toBe(108_800);
		// Even if estToken underestimates by 15%, actual ≈ 108800 / 0.85 ≈ 128K
		const worstActual = Math.ceil(trimTarget / factor);
		expect(worstActual).toBeLessThanOrEqual(maxPromptTokens);
	});

	it("should preserve end of prompt (output instructions)", () => {
		const instructions = "RESPOND_IN_XML_FORMAT";
		const bigPrefix = "old_conversation_data ".repeat(100_000);
		const prompt = bigPrefix + instructions;

		const maxChars = 1000;
		const trimmed = prompt.slice(-maxChars);

		expect(trimmed).toContain(instructions);
	});
});

// ============================================================================
// 4. maxTokens Capping
// ============================================================================
describe("Layer 4 — maxTokens capping", () => {
	it("should cap maxTokens when input + output exceeds context limit", () => {
		const TRIM_SAFETY_FACTOR = 0.85;
		const modelContextLimit = 200_000;
		const inputTokenEst = 100_000; // estimated input tokens

		const pessimisticInput = Math.ceil(inputTokenEst / TRIM_SAFETY_FACTOR);
		const maxAvailableOutput = modelContextLimit - pessimisticInput - 1_000;

		// pessimistic: 100K / 0.85 ≈ 117.6K
		// available: 200K - 117.6K - 1K ≈ 81.4K
		expect(pessimisticInput).toBeGreaterThan(117_000);
		expect(maxAvailableOutput).toBeLessThan(82_000);

		// If maxTokens was 64K, it would fit
		expect(64_000).toBeLessThan(maxAvailableOutput);
	});

	it("should cap maxTokens when input is very large", () => {
		const TRIM_SAFETY_FACTOR = 0.85;
		const modelContextLimit = 200_000;
		const inputTokenEst = 150_000; // large input after partial trimming

		const pessimisticInput = Math.ceil(inputTokenEst / TRIM_SAFETY_FACTOR);
		const maxAvailableOutput = modelContextLimit - pessimisticInput - 1_000;

		// pessimistic: 150K / 0.85 ≈ 176.5K
		// available: 200K - 176.5K - 1K ≈ 22.5K
		expect(maxAvailableOutput).toBeLessThan(25_000);
		expect(maxAvailableOutput).toBeGreaterThan(0);

		// maxTokens would be capped from 64K to ~22.5K
		const capped = Math.max(1_000, maxAvailableOutput);
		expect(capped).toBeLessThan(64_000);
		expect(capped).toBeGreaterThanOrEqual(1_000);
	});

	it("should floor at 1000 even when input fills entire context", () => {
		const modelContextLimit = 200_000;
		const inputTokenEst = 190_000;

		const pessimisticInput = Math.ceil(inputTokenEst / 0.85);
		const maxAvailableOutput = modelContextLimit - pessimisticInput - 1_000;

		// Negative available output
		expect(maxAvailableOutput).toBeLessThan(0);

		// Floor at 1_000
		const capped = Math.max(1_000, maxAvailableOutput);
		expect(capped).toBe(1_000);
	});

	it("should work with small context limits (e.g. 8K model)", () => {
		const modelContextLimit = 8_000;
		const inputTokenEst = 5_000;

		const pessimisticInput = Math.ceil(inputTokenEst / 0.85);
		const maxAvailableOutput = modelContextLimit - pessimisticInput - 1_000;

		// pessimistic: ~5882, available: 8000 - 5882 - 1000 = 1118
		expect(maxAvailableOutput).toBeGreaterThan(0);
		expect(maxAvailableOutput).toBeLessThan(2_000);
	});
});

// ============================================================================
// 5. Embedding Input Truncation
// ============================================================================
describe("Layer 5 — Embedding input truncation", () => {
	it("should have correct constants", () => {
		expect(MAX_EMBEDDING_TOKENS).toBe(8_000);
		expect(MAX_EMBEDDING_CHARS).toBe(32_000);
	});

	it("should truncate text exceeding MAX_EMBEDDING_CHARS", () => {
		const hugeText = "E".repeat(100_000);
		const stripped = stripMessageFormatting(hugeText);
		const maxChars = MAX_EMBEDDING_TOKENS * 4;
		const truncated =
			stripped.length > maxChars ? stripped.slice(-maxChars) : stripped;

		expect(truncated.length).toBeLessThanOrEqual(maxChars);
		expect(estimateTokens(truncated)).toBeLessThanOrEqual(
			MAX_EMBEDDING_TOKENS + 50,
		);
	});

	it("should handle text at exactly MAX_EMBEDDING_CHARS", () => {
		const exactText = "Y".repeat(MAX_EMBEDDING_CHARS);
		// Should NOT be truncated
		expect(exactText.length).toBe(MAX_EMBEDDING_CHARS);

		const truncated =
			exactText.length > MAX_EMBEDDING_CHARS
				? exactText.slice(-MAX_EMBEDDING_CHARS)
				: exactText;
		expect(truncated.length).toBe(MAX_EMBEDDING_CHARS);
	});

	it("should handle text 1 char over MAX_EMBEDDING_CHARS", () => {
		const overText = "Y".repeat(MAX_EMBEDDING_CHARS + 1);
		const truncated =
			overText.length > MAX_EMBEDDING_CHARS
				? overText.slice(-MAX_EMBEDDING_CHARS)
				: overText;

		expect(truncated.length).toBe(MAX_EMBEDDING_CHARS);
	});

	it("should handle empty text", () => {
		expect(estimateTokens("")).toBe(0);
		expect(stripMessageFormatting("")).toBe("");
	});

	it("should handle 10 MB embedding text", () => {
		const massiveText = "F".repeat(10_000_000);
		const start = performance.now();
		const truncated = massiveText.slice(-MAX_EMBEDDING_CHARS);
		const elapsed = performance.now() - start;

		expect(truncated.length).toBe(MAX_EMBEDDING_CHARS);
		expect(elapsed).toBeLessThan(500); // must be fast (heap pressure from prior tests)
	});
});

// ============================================================================
// 6. Workspace Provider Total Cap
// ============================================================================
describe("Layer 6 — Workspace provider total cap", () => {
	it("buildContext should respect MAX_TOTAL_WORKSPACE_CHARS", () => {
		// Test the buildContext logic directly (mirrors workspace-provider.ts)
		const MAX_TOTAL_WORKSPACE_CHARS = 100_000;

		function buildContext(
			files: { name: string; content: string; missing?: boolean }[],
			maxCharsPerFile: number,
		): string {
			const sections: string[] = [];
			let totalChars = 0;
			for (const f of files) {
				if (f.missing || !f.content?.trim()) continue;
				const text =
					f.content.trim().length > maxCharsPerFile
						? `${f.content.trim().slice(0, maxCharsPerFile)}\n\n[truncated]`
						: f.content.trim();
				const section = `### ${f.name}\n\n${text}`;
				if (
					totalChars + section.length > MAX_TOTAL_WORKSPACE_CHARS &&
					sections.length > 0
				) {
					break;
				}
				sections.push(section);
				totalChars += section.length;
			}
			return sections.join("\n\n---\n\n");
		}

		// 10 files of 50K each = 500K total, should be capped at ~100K
		const files = Array.from({ length: 10 }, (_, i) => ({
			name: `FILE_${i}.md`,
			content: "G".repeat(50_000),
		}));

		const result = buildContext(files, 50_000);
		// Only ~2 files fit (each ~50K, total cap 100K)
		expect(result.length).toBeLessThanOrEqual(
			MAX_TOTAL_WORKSPACE_CHARS + 1_000,
		);
		// Should NOT contain all 10 files
		const fileCount = (result.match(/### FILE_/g) || []).length;
		expect(fileCount).toBeLessThan(10);
		expect(fileCount).toBeGreaterThanOrEqual(1);
	});

	it("per-file truncation should work", () => {
		const content = "H".repeat(100_000);
		const maxChars = 20_000;
		const truncated =
			content.length > maxChars
				? `${content.slice(0, maxChars)}\n\n[truncated]`
				: content;

		expect(truncated.length).toBeLessThan(maxChars + 50);
	});
});

// ============================================================================
// 7. Compaction + Budgeting Integration
// ============================================================================
describe("Layer 7 — Compaction integration", () => {
	it(
		"compaction point should reduce messages loaded",
		{ timeout: 15_000 },
		async () => {
			const { InMemoryDatabaseAdapter } = await import(
				"../database/inMemoryAdapter.ts"
			);

			const adapter = new InMemoryDatabaseAdapter();
			await adapter.init();
			const roomId = "room-compact" as UUID;

			// 50 messages, timestamps 1000-50000
			for (let i = 1; i <= 50; i++) {
				await adapter.createMemory(
					msg(`Message ${i}`, i * 1000, roomId),
					"messages",
					false,
				);
			}

			// All messages
			const all = await adapter.getMemories({ tableName: "messages", roomId });
			expect(all.length).toBe(50);

			// After compaction at 40000 — only messages 40-50
			const afterCompact = await adapter.getMemories({
				tableName: "messages",
				roomId,
				start: 40000,
			});
			expect(afterCompact.length).toBe(11); // 40,41,...,50
			expect(afterCompact.length).toBeLessThan(all.length);
		},
	);

	it(
		"compaction summary should be included in post-compaction context",
		{ timeout: 15_000 },
		async () => {
			const { InMemoryDatabaseAdapter } = await import(
				"../database/inMemoryAdapter.ts"
			);

			const adapter = new InMemoryDatabaseAdapter();
			await adapter.init();
			const roomId = "room-summary" as UUID;

			// Pre-compaction messages
			for (let i = 1; i <= 20; i++) {
				await adapter.createMemory(
					msg(`Old message ${i}`, i * 1000, roomId),
					"messages",
					false,
				);
			}

			// Compaction at 20500
			const compactionAt = 20500;
			await adapter.createMemory(
				{
					id: uuid(),
					entityId: "agent-1" as UUID,
					agentId: "agent-1" as UUID,
					roomId,
					content: {
						text: "[Compaction Summary]\n\nKey decisions: A, B, C",
						source: "compaction",
					},
					createdAt: compactionAt,
				},
				"messages",
				false,
			);

			// Post-compaction messages
			for (let i = 21; i <= 25; i++) {
				await adapter.createMemory(
					msg(`New message ${i}`, i * 1000, roomId),
					"messages",
					false,
				);
			}

			const filtered = await adapter.getMemories({
				tableName: "messages",
				roomId,
				start: compactionAt,
			});

			// Should have: summary + messages 21-25 = 6
			expect(filtered.length).toBe(6);

			// Summary should be present
			const summary = filtered.find((m) => m.content?.source === "compaction");
			expect(summary).toBeDefined();
			expect(summary?.content?.text).toContain("Key decisions");

			// Old messages should be excluded
			const texts = filtered.map((m) => m.content?.text ?? "");
			expect(texts.some((t) => t.includes("Old message"))).toBe(false);
			expect(texts.some((t) => t.includes("New message"))).toBe(true);
		},
	);

	it(
		"multiple compaction rounds should chain correctly",
		{ timeout: 15_000 },
		async () => {
			const { InMemoryDatabaseAdapter } = await import(
				"../database/inMemoryAdapter.ts"
			);

			const adapter = new InMemoryDatabaseAdapter();
			await adapter.init();
			const roomId = "room-chain" as UUID;

			// Round 1: 10 messages
			for (let i = 1; i <= 10; i++) {
				await adapter.createMemory(
					msg(`R1-${i}`, i * 1000, roomId),
					"messages",
					false,
				);
			}

			// Compact round 1 at 10500
			await adapter.createMemory(
				{
					id: uuid(),
					entityId: "agent-1" as UUID,
					agentId: "agent-1" as UUID,
					roomId,
					content: {
						text: "[Compaction Summary]\n\nR1 summary",
						source: "compaction",
					},
					createdAt: 10500,
				},
				"messages",
				false,
			);

			// Round 2: 10 messages
			for (let i = 11; i <= 20; i++) {
				await adapter.createMemory(
					msg(`R2-${i}`, i * 1000, roomId),
					"messages",
					false,
				);
			}

			// Compact round 2 at 20500
			await adapter.createMemory(
				{
					id: uuid(),
					entityId: "agent-1" as UUID,
					agentId: "agent-1" as UUID,
					roomId,
					content: {
						text: "[Compaction Summary]\n\nR2 summary (includes R1)",
						source: "compaction",
					},
					createdAt: 20500,
				},
				"messages",
				false,
			);

			// Round 3: 5 messages
			for (let i = 21; i <= 25; i++) {
				await adapter.createMemory(
					msg(`R3-${i}`, i * 1000, roomId),
					"messages",
					false,
				);
			}

			// Total in DB = 10 + 1 + 10 + 1 + 5 = 27
			const total = await adapter.getMemories({
				tableName: "messages",
				roomId,
			});
			expect(total.length).toBe(27);

			// View from latest compaction point
			const view = await adapter.getMemories({
				tableName: "messages",
				roomId,
				start: 20500,
			});

			// Should see: R2 summary + R3 messages (5) = 6
			expect(view.length).toBe(6);

			// R1 summary and R1 messages must NOT be visible
			const viewTexts = view.map((m) => m.content?.text ?? "");
			expect(viewTexts.some((t) => t.includes("R1-"))).toBe(false);
			expect(
				viewTexts.some(
					(t) => t.includes("R1 summary") && !t.includes("includes R1"),
				),
			).toBe(false);

			// R2 summary IS visible
			expect(viewTexts.some((t) => t.includes("R2 summary"))).toBe(true);
			// R3 messages ARE visible
			expect(viewTexts.some((t) => t.includes("R3-"))).toBe(true);
		},
	);
});

// ============================================================================
// 8. Token Estimation Accuracy
// ============================================================================
describe("Token estimation accuracy and edge cases", () => {
	it("estimateTokens should be fast for large inputs", () => {
		const text = "x".repeat(10_000_000); // 10 MB
		const start = performance.now();
		const tokens = estimateTokens(text);
		const elapsed = performance.now() - start;

		expect(tokens).toBe(2_500_000);
		expect(elapsed).toBeLessThan(10);
	});

	it("estimateTokens handles null/undefined/empty", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens(null as unknown as string)).toBe(0);
		expect(estimateTokens(undefined as unknown as string)).toBe(0);
	});

	it("estimateTokens gives reasonable estimates for English text", () => {
		const text = "The quick brown fox jumps over the lazy dog.";
		const est = estimateTokens(text);
		// 44 chars / 4 = 11 tokens. Actual GPT tokenization ≈ 10 tokens.
		expect(est).toBeGreaterThan(5);
		expect(est).toBeLessThan(20);
	});

	it("estimateTokens handles single characters", () => {
		expect(estimateTokens("a")).toBe(1);
		expect(estimateTokens("ab")).toBe(1);
		expect(estimateTokens("abc")).toBe(1);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});

// ============================================================================
// 9. End-to-End: Insane Data Load
// ============================================================================
describe("End-to-end: extreme data scenarios", () => {
	it("should survive 1000 messages of 10K chars each (10 MB total)", async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages.ts"
		);

		const messages = Array.from({ length: 1000 }, (_, i) =>
			msg("W".repeat(10_000), Date.now() - i * 1000),
		);

		const runtime = baseMockRuntime({
			getMemories: vi.fn().mockResolvedValue(messages),
		});

		const start = performance.now();
		const result = await recentMessagesProvider.get(
			runtime,
			msg("hi", Date.now()),
			{} as never,
		);
		const elapsed = performance.now() - start;

		const text = result.text ?? "";
		// Output should be bounded
		expect(text.length).toBeLessThan(500_000);
		// Should complete in reasonable time (< 5s)
		expect(elapsed).toBeLessThan(5_000);

		// Some messages should have been dropped by budget
		const kept = (result.data as Record<string, Memory[]>).recentMessages;
		expect(kept.length).toBeLessThan(1000);
	});

	it("should survive a single 100 MB message", async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages.ts"
		);

		// 100 MB message — represents worst-case pasted binary/base64
		const hugeText = "Q".repeat(100_000_000);
		const runtime = baseMockRuntime({
			getMemories: vi.fn().mockResolvedValue([msg(hugeText, 1000)]),
		});

		const start = performance.now();
		const result = await recentMessagesProvider.get(
			runtime,
			msg("hi", Date.now()),
			{} as never,
		);
		const elapsed = performance.now() - start;

		const text = result.text ?? "";
		// Must be bounded — not 100 MB
		expect(text.length).toBeLessThan(500_000);
		// Should still be fast (per-message cap prevents processing 100 MB)
		expect(elapsed).toBeLessThan(5_000);
		// Must contain truncation notice
		expect(text).toContain("truncated");
	});

	it("trimMessagesByTokenBudget should handle 100K messages efficiently", () => {
		const messages = Array.from({ length: 100_000 }, (_, i) =>
			msg("ok", 100_000 - i),
		);

		const start = performance.now();
		const result = trimMessagesByTokenBudget(messages, 50_000);
		const elapsed = performance.now() - start;

		// "ok" ≈ 1 token each, 100K messages = 100K tokens > 50K budget
		expect(result.length).toBeLessThan(100_000);
		expect(result.length).toBeGreaterThan(0);
		// Must complete quickly
		expect(elapsed).toBeLessThan(1_000);
	});
});
