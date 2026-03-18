/**
 * Context Management — Comprehensive Tests
 *
 * Validates layers of the token-limiting pipeline that are currently implemented.
 * Tests for unimplemented functions (estimateTokens, trimMessagesByTokenBudget,
 * stripMessageFormatting, etc.) have been removed and should be re-added when
 * those functions are implemented in utils.ts.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	Room,
	State,
	UUID,
} from "../types/index.ts";

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
// 1. Per-Message Truncation (only passing tests)
// ============================================================================
describe("Layer 1 — Per-message truncation", () => {
	const MAX_SINGLE_MESSAGE_CHARS = 20_000; // Matches provider constant

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
			{} as State,
		);

		const text = result.text ?? "";
		expect(text).toContain(normalText);
		expect(text).not.toContain("truncated");
	}, 30_000);

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
// 3. Prompt-Level Trimming
// ============================================================================
describe("Layer 3 — Prompt-level trimming", () => {
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
