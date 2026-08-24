/**
 * Coverage for the advanced-memory evaluators barrel (`evaluators/index.ts`)
 * and the evaluator surface it publishes.
 *
 * The barrel exists because Bun.build's tree-shaker elided a pure
 * `export { … } from` re-export into an empty module init, crashing the mobile
 * agent bundle with `ReferenceError: memoryItems is not defined`. Every lookup
 * here goes through the barrel — exactly as `createAdvancedMemoryPlugin` does
 * — and then drives the real evaluator behind the binding: the shouldRun gate,
 * prepare/prompt composition, model-output parsing, and the store processor.
 *
 * Deterministic harness: structural fakes for IAgentRuntime/MemoryService only;
 * the module under test is always the real one.
 */
import { describe, expect, it, vi } from "vitest";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import type { MemoryService } from "../services/memory-service.ts";
import type { MemoryConfig } from "../types.ts";
import {
	longTermMemoryEvaluator as barrelEvaluator,
	memoryItems as barrelMemoryItems,
} from "./index.ts";
import type {
	LongTermMemoryOutput,
	LongTermMemoryPrepared,
} from "./memory-items.ts";
import {
	longTermMemoryEvaluator as directEvaluator,
	memoryItems as directMemoryItems,
} from "./memory-items.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;

function config(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
	return {
		longTermExtractionEnabled: true,
		longTermVectorSearchEnabled: false,
		longTermConfidenceThreshold: 0.6,
		longTermExtractionThreshold: 5,
		longTermExtractionInterval: 10,
		...overrides,
	};
}

function fakeService(overrides: Partial<MemoryConfig> = {}) {
	const stored: Array<Record<string, unknown>> = [];
	const service = {
		getConfig: vi.fn(() => config(overrides)),
		shouldRunExtraction: vi.fn(async () => true),
		getLongTermMemories: vi.fn(async () => []),
		storeLongTermMemory: vi.fn(async (record: Record<string, unknown>) => {
			stored.push(record);
		}),
		setLastExtractionCheckpoint: vi.fn(async () => {}),
	};
	return {
		service: service as unknown as MemoryService,
		stored,
		shouldRunExtraction: service.shouldRunExtraction,
		getLongTermMemories: service.getLongTermMemories,
		storeLongTermMemory: service.storeLongTermMemory,
		setLastExtractionCheckpoint: service.setLastExtractionCheckpoint,
	};
}

function runtimeWith(
	service: MemoryService | null,
	options: { count?: number; memories?: Memory[] } = {},
): IAgentRuntime {
	return createMockRuntime({
		agentId,
		getService: (name) => (name === "memory" ? service : null),
		countMemories: vi.fn(async () => options.count ?? 4),
		getMemories: vi.fn(async () => options.memories ?? []),
	});
}

function msgWith(fields: Record<string, unknown>): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000dd" as UUID,
		agentId,
		entityId,
		roomId,
		content: { text: "I moved to Lisbon last month." },
		createdAt: 1,
		...fields,
	} as unknown as Memory;
}

function run(
	message: Memory,
	service: MemoryService | null = fakeService().service,
) {
	const runtime = runtimeWith(service);
	return {
		runtime,
		result: barrelEvaluator.shouldRun({ runtime, message, options: {} }),
	};
}

function preparedFixture(
	service: MemoryService,
	overrides: Partial<LongTermMemoryPrepared> = {},
): LongTermMemoryPrepared {
	return {
		memoryService: service,
		recentMessages: [],
		existingMemories: "None yet",
		currentMessageCount: 7,
		...overrides,
	};
}

describe("advanced-memory evaluators barrel", () => {
	it("publishes live value bindings identical to the evaluator module", () => {
		expect(Array.isArray(barrelMemoryItems)).toBe(true);
		expect(barrelMemoryItems).toBe(directMemoryItems);
		expect(barrelEvaluator).toBe(directEvaluator);
	});

	it("exposes exactly the long-term evaluator under its registered identity", () => {
		expect(barrelMemoryItems).toEqual([barrelEvaluator]);
		expect(barrelEvaluator.name).toBe("longTermMemory");
		expect(typeof barrelEvaluator.description).toBe("string");
		expect(barrelEvaluator.description.length).toBeGreaterThan(0);
		expect(barrelEvaluator.priority).toBe(EvaluatorPriority.MEMORY_LONG_TERM);
	});
});

describe("longTermMemory shouldRun gate", () => {
	it("rejects a message without text before touching any service", async () => {
		const { result } = run(msgWith({ content: { text: "" } }));
		await expect(result).resolves.toBe(false);
	});

	it("rejects a message without a room", async () => {
		const { result } = run(msgWith({ roomId: undefined }));
		await expect(result).resolves.toBe(false);
	});

	it("rejects a message without an authoring entity", async () => {
		const { result } = run(msgWith({ entityId: undefined }));
		await expect(result).resolves.toBe(false);
	});

	it("declines when no memory service is registered", async () => {
		const { result } = run(msgWith({}), null);
		await expect(result).resolves.toBe(false);
	});

	it("never extracts facts about the agent from its own messages", async () => {
		const fake = fakeService();
		const runtime = runtimeWith(fake.service);
		const shouldRun = barrelEvaluator.shouldRun({
			runtime,
			message: msgWith({ entityId: agentId }),
			options: {},
		});
		await expect(shouldRun).resolves.toBe(false);
		expect(fake.shouldRunExtraction).not.toHaveBeenCalled();
	});

	it("declines while long-term extraction is disabled in config", async () => {
		const fake = fakeService({ longTermExtractionEnabled: false });
		await expect(
			barrelEvaluator.shouldRun({
				runtime: runtimeWith(fake.service),
				message: msgWith({}),
				options: {},
			}),
		).resolves.toBe(false);
		expect(fake.shouldRunExtraction).not.toHaveBeenCalled();
	});

	it("runs when enabled and the extraction cadence allows it", async () => {
		const fake = fakeService();
		const runtime = runtimeWith(fake.service, { count: 12 });
		await expect(
			barrelEvaluator.shouldRun({
				runtime,
				message: msgWith({}),
				options: {},
			}),
		).resolves.toBe(true);
		expect(fake.shouldRunExtraction).toHaveBeenCalledWith(entityId, roomId, 12);
	});

	it("waits when the extraction cadence says the window is not due", async () => {
		const fake = fakeService();
		fake.shouldRunExtraction.mockResolvedValue(false);
		await expect(
			barrelEvaluator.shouldRun({
				runtime: runtimeWith(fake.service),
				message: msgWith({}),
				options: {},
			}),
		).resolves.toBe(false);
	});
});

describe("longTermMemory prepare", () => {
	it("fails loudly when the memory service is missing instead of degrading silently", async () => {
		await expect(
			barrelEvaluator.prepare?.({
				runtime: runtimeWith(null),
				message: msgWith({}),
				state: {} as State,
				options: {},
			}),
		).rejects.toThrow("MemoryService not found");
	});

	it("reports 'None yet' for a user without stored memories and passes the message count through", async () => {
		const fake = fakeService();
		fake.getLongTermMemories.mockResolvedValue([]);
		const prepared = await barrelEvaluator.prepare?.({
			runtime: runtimeWith(fake.service, { count: 9 }),
			message: msgWith({}),
			state: {} as State,
			options: {},
		});
		expect(prepared?.existingMemories).toBe("None yet");
		expect(prepared?.currentMessageCount).toBe(9);
	});

	it("renders each stored memory as '[category] content (confidence: N)'", async () => {
		const fake = fakeService();
		fake.getLongTermMemories.mockResolvedValue([
			{
				category: "semantic",
				content: "Lives in Lisbon",
				confidence: 0.92,
			},
		]);
		const prepared = await barrelEvaluator.prepare?.({
			runtime: runtimeWith(fake.service),
			message: msgWith({}),
			state: {} as State,
			options: {},
		});
		expect(prepared?.existingMemories).toBe(
			"[semantic] Lives in Lisbon (confidence: 0.92)",
		);
	});
});

describe("longTermMemory prompt composition", () => {
	function promptFor(prepared: LongTermMemoryPrepared): string {
		const runtime = runtimeWith(fakeService().service);
		return barrelEvaluator.prompt({
			runtime,
			message: msgWith({}),
			state: {} as State,
			options: {},
			prepared,
		});
	}

	it("interpolates the existing-memory block and formats dialogue turns by speaker", () => {
		const fake = fakeService().service;
		const prompt = promptFor(
			preparedFixture(fake, {
				existingMemories: "[semantic] Lives in Lisbon (confidence: 0.92)",
				recentMessages: [
					msgWith({
						content: {
							text: "Where should I eat tonight?",
							senderName: "Alice",
						},
					}),
					msgWith({
						entityId: agentId,
						content: { text: "The riverside market is great." },
					}),
					msgWith({ content: { text: "", senderName: "Bob" } }),
				],
			}),
		);

		expect(prompt).toContain("[semantic] Lives in Lisbon (confidence: 0.92)");
		expect(prompt).toContain("Recent messages:");
		expect(prompt).toContain("Alice: Where should I eat tonight?");
		expect(prompt).toContain("MockAgent: The riverside market is great.");
		expect(prompt).toContain("[non-text message]");
	});
});

describe("longTermMemory parse", () => {
	it("returns null for non-object output and for a missing memories array", () => {
		expect(barrelEvaluator.parse?.("memories")).toBeNull();
		expect(barrelEvaluator.parse?.(null)).toBeNull();
		expect(barrelEvaluator.parse?.({ memories: "everything" })).toBeNull();
	});

	it("normalizes valid entries and drops invalid ones while preserving order", () => {
		const parsed = barrelEvaluator.parse?.({
			memories: [
				{
					category: "  SEMANTIC ",
					content: "  Prefers concise answers ",
					confidence: 0.9,
				},
				{ category: "gossip", content: "unknown category", confidence: 0.99 },
				{ category: "episodic", content: "   ", confidence: 0.9 },
				{ category: "episodic", content: "no confidence" },
				42,
				{
					category: "procedural",
					content: "Rents a scooter monthly",
					confidence: 0.95,
				},
			],
		}) as LongTermMemoryOutput;

		expect(parsed).toEqual({
			memories: [
				{
					category: "semantic",
					content: "Prefers concise answers",
					confidence: 0.9,
				},
				{
					category: "procedural",
					content: "Rents a scooter monthly",
					confidence: 0.95,
				},
			],
		});
	});
});

describe("longTermMemory store processor", () => {
	function processOutput(
		fake: ReturnType<typeof fakeService>,
		output: LongTermMemoryOutput,
		count = 7,
	) {
		const processor = barrelEvaluator.processors?.[0];
		if (!processor) throw new Error("store processor missing");
		return processor.process({
			runtime: runtimeWith(fake.service),
			message: msgWith({}),
			state: {} as State,
			options: {},
			evaluatorName: "longTermMemory",
			prepared: preparedFixture(fake.service, { currentMessageCount: count }),
			output,
		});
	}

	it("stores only extractions meeting the 0.85 floor and checkpoints the turn", async () => {
		const fake = fakeService({ longTermConfidenceThreshold: 0.6 });
		const result = await processOutput(fake, {
			memories: [
				{ category: "semantic", content: "Kept at 0.9", confidence: 0.9 },
				{ category: "episodic", content: "Dropped at 0.84", confidence: 0.84 },
				{ category: "procedural", content: "Kept at floor", confidence: 0.85 },
			],
		});

		expect(result).toEqual({
			success: true,
			values: { longTermStored: 2 },
		});
		expect(fake.stored.map((record) => record.content)).toEqual([
			"Kept at 0.9",
			"Kept at floor",
		]);
		for (const record of fake.stored) {
			expect(record).toMatchObject({
				agentId,
				entityId,
				category: record.category,
				source: "conversation",
				metadata: { roomId },
			});
		}
		expect(fake.setLastExtractionCheckpoint).toHaveBeenCalledWith(
			entityId,
			roomId,
			7,
		);
	});

	it("raises the floor when config demands stricter confidence than 0.85", async () => {
		const fake = fakeService({ longTermConfidenceThreshold: 0.95 });
		const result = await processOutput(fake, {
			memories: [
				{
					category: "semantic",
					content: "Below strict floor",
					confidence: 0.9,
				},
				{
					category: "semantic",
					content: "Above strict floor",
					confidence: 0.97,
				},
			],
		});

		expect(result).toEqual({ success: true, values: { longTermStored: 1 } });
		expect(fake.stored.map((record) => record.content)).toEqual([
			"Above strict floor",
		]);
	});

	it("still checkpoints and succeeds when nothing qualifies", async () => {
		const fake = fakeService();
		const result = await processOutput(fake, {
			memories: [
				{ category: "semantic", content: "Too weak", confidence: 0.1 },
			],
		});

		expect(result).toEqual({ success: true, values: { longTermStored: 0 } });
		expect(fake.storeLongTermMemory).not.toHaveBeenCalled();
		expect(fake.setLastExtractionCheckpoint).toHaveBeenCalledOnce();
	});
});
