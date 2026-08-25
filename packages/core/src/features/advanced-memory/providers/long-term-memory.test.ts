/**
 * Deterministic unit coverage for the long-term-memory provider's service
 * gates, category rendering, result metadata, and explicit unavailable state.
 * Uses the real provider and formatter with an in-memory service boundary.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { type LongTermMemory, LongTermMemoryCategory } from "../types.ts";
import { longTermMemoryProvider } from "./long-term-memory.ts";

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

async function get(runtime: IAgentRuntime, input = message()) {
	return longTermMemoryProvider.get(runtime, input, {} as State);
}

describe("longTermMemoryProvider", () => {
	it("declares the turn-scoped general-user provider contract", () => {
		expect(longTermMemoryProvider).toMatchObject({
			name: "LONG_TERM_MEMORY",
			description: "Persistent facts and preferences about the user",
			position: 50,
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
	});

	it("returns an empty contribution when the memory service is unavailable", async () => {
		const runtime = createMockRuntime({
			agentId,
			getService: () => null,
		});

		await expect(get(runtime)).resolves.toEqual({
			data: { memoryCount: 0 },
			values: { longTermMemories: "" },
			text: "",
		});
	});

	it("does not query memories for a message authored by the agent", async () => {
		const getLongTermMemories = vi.fn(async () => []);
		const runtime = runtimeWithService(getLongTermMemories);

		await expect(get(runtime, message(agentId))).resolves.toEqual({
			data: { memoryCount: 0 },
			values: { longTermMemories: "" },
			text: "",
		});
		expect(getLongTermMemories).not.toHaveBeenCalled();
	});

	it("returns an empty contribution when the user has no stored memories", async () => {
		const getLongTermMemories = vi.fn(async () => []);
		const runtime = runtimeWithService(getLongTermMemories);

		await expect(get(runtime)).resolves.toEqual({
			data: { memoryCount: 0 },
			values: { longTermMemories: "" },
			text: "",
		});
		expect(getLongTermMemories).toHaveBeenCalledOnce();
		expect(getLongTermMemories).toHaveBeenCalledWith(entityId);
	});

	it("renders every memory and counts repeated categories in first-seen order", async () => {
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
			longTermMemory(
				"00000000-0000-0000-0000-000000000003",
				LongTermMemoryCategory.SEMANTIC,
				"Works in software",
			),
		];
		const runtime = runtimeWithService(vi.fn(async () => memories));

		const result = await get(runtime);
		const expectedText = [
			"# What I Know About You",
			"**Semantic**:",
			"- Prefers concise answers",
			"- Works in software",
			"",
			"**Episodic**:",
			"- Visited Kyoto in spring",
			"",
		].join("\n");

		expect(result).toEqual({
			data: {
				memoryCount: 3,
				categories: "semantic: 2, episodic: 1",
				truncated: false,
			},
			values: {
				longTermMemories: expectedText,
				memoryCategories: "semantic: 2, episodic: 1",
			},
			text: expectedText,
		});
	});

	it.each([
		{ failure: new Error("storage offline"), expectedError: "storage offline" },
		{ failure: "storage offline", expectedError: "storage offline" },
	])(
		"reports $failure and returns an explicit unavailable state",
		async ({ failure, expectedError }) => {
			const reportError = vi.fn<IAgentRuntime["reportError"]>();
			const runtime = runtimeWithService(async () => {
				throw failure;
			}, reportError);

			await expect(get(runtime)).resolves.toEqual({
				data: { available: false, error: expectedError },
				values: { longTermMemoryAvailable: false },
				text: "Long-term memory is unavailable.",
			});
			expect(reportError).toHaveBeenCalledWith(
				"LongTermMemoryProvider.get",
				failure,
				{ roomId },
			);
		},
	);
});
