/**
 * Deterministic unit coverage for the advanced-memory providers barrel: the
 * re-exported binding must stay identical to the live implementation export
 * and reach `createAdvancedMemoryPlugin` intact and fully functional. Uses
 * the real provider and real plugin assembly with an in-memory service
 * boundary.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { createAdvancedMemoryPlugin } from "../index.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { type LongTermMemory, LongTermMemoryCategory } from "../types.ts";
import { longTermMemoryProvider } from "./index.ts";
import { longTermMemoryProvider as implementationLongTermMemoryProvider } from "./long-term-memory.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;

function message(senderId: UUID = entityId): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000dd" as UUID,
		agentId,
		entityId: senderId,
		roomId,
		content: { text: "What do you remember?" },
		createdAt: 1,
	};
}

function longTermMemory(
	id: string,
	category: LongTermMemoryCategory,
	content: string,
): LongTermMemory {
	return {
		id: id as UUID,
		agentId,
		entityId,
		category,
		content,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

function runtimeWithService(
	getLongTermMemories: MemoryService["getLongTermMemories"],
	reportError: IAgentRuntime["reportError"] = vi.fn(),
): IAgentRuntime {
	const memoryService = { getLongTermMemories } as MemoryService;
	return createMockRuntime({
		agentId,
		getService: (name) => (name === "memory" ? memoryService : null),
		reportError,
	});
}

describe("advanced-memory providers barrel", () => {
	it("re-exports the live implementation binding", () => {
		expect(longTermMemoryProvider).toBe(implementationLongTermMemoryProvider);
	});

	it("hands the same provider instance to createAdvancedMemoryPlugin", () => {
		const plugin = createAdvancedMemoryPlugin();

		expect(plugin.name).toBe("memory");
		expect(plugin.providers).toHaveLength(1);
		expect(plugin.providers?.[0]).toBe(longTermMemoryProvider);
	});

	it("exposes a fully functional provider through the barrel path", async () => {
		const memories = [
			longTermMemory(
				"00000000-0000-0000-0000-000000000001",
				LongTermMemoryCategory.SEMANTIC,
				"Prefers concise answers",
			),
			longTermMemory(
				"00000000-0000-0000-0000-000000000002",
				LongTermMemoryCategory.EPISODIC,
				"Visited Kyoto in spring",
			),
		];
		const runtime = runtimeWithService(vi.fn(async () => memories));

		const result = await longTermMemoryProvider.get(
			runtime,
			message(),
			{} as State,
		);

		const expectedText = [
			"# What I Know About You",
			"**Semantic**:",
			"- Prefers concise answers",
			"",
			"**Episodic**:",
			"- Visited Kyoto in spring",
			"",
		].join("\n");

		expect(result).toEqual({
			data: {
				memoryCount: 2,
				categories: "semantic: 1, episodic: 1",
				complete: true,
			},
			values: {
				longTermMemories: expectedText,
				memoryCategories: "semantic: 1, episodic: 1",
			},
			text: expectedText,
		});
	});
});
