/**
 * Unit coverage for the long-term-memory evaluator exported by
 * `memory-items.ts`, driving the real evaluator object through every lifecycle
 * stage: `shouldRun` gating, `prepare` context assembly, prompt rendering,
 * model-output parsing, and the storage processor's confidence floor.
 *
 * Harness is deterministic unit-level: a typed mock runtime
 * (`createMockRuntime`) plus a recording MemoryService double. No database,
 * network, or model is involved.
 */
import { describe, expect, it, vi } from "vitest";
import {
	createMockRuntime,
	MOCK_AGENT_ID,
} from "../../../testing/mock-runtime.ts";
import type { Memory } from "../../../types/memory.ts";
import type { UUID } from "../../../types/primitives.ts";
import type { State } from "../../../types/state.ts";
import type { MemoryService } from "../services/memory-service.ts";
import {
	type LongTermMemory,
	LongTermMemoryCategory,
	type MemoryConfig,
} from "../types.ts";
import { longTermMemoryEvaluator, memoryItems } from "./memory-items.ts";

const ENTITY_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;
const OTHER_ENTITY_ID = "00000000-0000-0000-0000-0000000000e2" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000f1" as UUID;

type NewLongTermMemory = Omit<
	LongTermMemory,
	"id" | "createdAt" | "updatedAt" | "accessCount"
>;

let recordSeq = 0;

function longTermRecord(
	overrides: Partial<NewLongTermMemory> = {},
): LongTermMemory {
	recordSeq += 1;
	const id =
		`00000000-0000-0000-0000-${String(recordSeq).padStart(12, "0")}` as UUID;
	return {
		id,
		agentId: MOCK_AGENT_ID,
		entityId: ENTITY_ID,
		category: LongTermMemoryCategory.SEMANTIC,
		content: `fact ${recordSeq}`,
		confidence: 0.9,
		source: "conversation",
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

function message(overrides: Partial<Memory> = {}): Memory {
	return {
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "hello there" },
		...overrides,
	};
}

function makeService(
	options: {
		config?: Partial<MemoryConfig>;
		existing?: LongTermMemory[];
		shouldRun?: boolean;
	} = {},
) {
	const config: MemoryConfig = {
		longTermExtractionEnabled: true,
		longTermVectorSearchEnabled: false,
		longTermConfidenceThreshold: 0.5,
		longTermExtractionThreshold: 5,
		longTermExtractionInterval: 10,
		...options.config,
	};
	const stored: NewLongTermMemory[] = [];
	const shouldRunExtraction = vi.fn(async () => options.shouldRun ?? true);
	const getLongTermMemories = vi.fn(async () => options.existing ?? []);
	const storeLongTermMemory = vi.fn(
		async (memory: NewLongTermMemory): Promise<LongTermMemory> => {
			stored.push(memory);
			return longTermRecord(memory);
		},
	);
	const setLastExtractionCheckpoint = vi.fn(async () => {});
	const service = {
		getConfig: () => ({ ...config }),
		shouldRunExtraction,
		getLongTermMemories,
		storeLongTermMemory,
		setLastExtractionCheckpoint,
	} as unknown as MemoryService;
	return {
		service,
		shouldRunExtraction,
		getLongTermMemories,
		storeLongTermMemory,
		setLastExtractionCheckpoint,
		stored,
	};
}

function makeRuntime(
	service: MemoryService | null,
	overrides: {
		count?: number;
		rows?: Memory[];
		getService?: MemoryService | null;
	} = {},
) {
	return createMockRuntime({
		countMemories: vi.fn(async () => overrides.count ?? 12),
		getMemories: vi.fn(async () => overrides.rows ?? []),
		getService: vi.fn((type: string) =>
			type === "memory" ? (overrides.getService ?? service) : null,
		),
	});
}

function runContext(
	runtime: ReturnType<typeof createMockRuntime>,
	msg: Memory,
) {
	return { runtime, message: msg, options: {} };
}

function promptContext(
	runtime: ReturnType<typeof createMockRuntime>,
	msg: Memory,
	prepared: Parameters<typeof longTermMemoryEvaluator.prompt>[0]["prepared"],
) {
	return {
		runtime,
		message: msg,
		state: {} as State,
		options: {},
		prepared,
	};
}

describe("longTermMemoryEvaluator.shouldRun", () => {
	it("rejects incomplete messages without consulting the memory service", async () => {
		const getService = vi.fn(() => null);
		const runtime = createMockRuntime({ getService });

		await expect(
			longTermMemoryEvaluator.shouldRun(
				runContext(runtime, message({ content: { text: "" } })),
			),
		).resolves.toBe(false);
		await expect(
			longTermMemoryEvaluator.shouldRun(
				runContext(runtime, message({ roomId: undefined as unknown as UUID })),
			),
		).resolves.toBe(false);
		await expect(
			longTermMemoryEvaluator.shouldRun(
				runContext(
					runtime,
					message({ entityId: undefined as unknown as UUID }),
				),
			),
		).resolves.toBe(false);

		expect(getService).not.toHaveBeenCalled();
	});

	it("returns false when no memory service is registered", async () => {
		const runtime = makeRuntime(null);

		await expect(
			longTermMemoryEvaluator.shouldRun(runContext(runtime, message())),
		).resolves.toBe(false);
	});

	it("skips the agent's own messages even when extraction is enabled", async () => {
		const double = makeService({ shouldRun: true });
		const runtime = makeRuntime(double.service);

		await expect(
			longTermMemoryEvaluator.shouldRun(
				runContext(runtime, message({ entityId: MOCK_AGENT_ID })),
			),
		).resolves.toBe(false);
		expect(double.shouldRunExtraction).not.toHaveBeenCalled();
	});

	it("returns false when long-term extraction is disabled, before counting messages", async () => {
		const double = makeService({
			config: { longTermExtractionEnabled: false },
		});
		const countMemories = vi.fn(async () => 50);
		const runtime = createMockRuntime({
			countMemories,
			getService: vi.fn((type: string) =>
				type === "memory" ? double.service : null,
			),
		});

		await expect(
			longTermMemoryEvaluator.shouldRun(runContext(runtime, message())),
		).resolves.toBe(false);
		expect(countMemories).not.toHaveBeenCalled();
	});

	it("delegates to shouldRunExtraction with the live room message count", async () => {
		const double = makeService({ shouldRun: true });
		const runtime = makeRuntime(double.service, { count: 12 });

		await expect(
			longTermMemoryEvaluator.shouldRun(runContext(runtime, message())),
		).resolves.toBe(true);
		expect(double.shouldRunExtraction).toHaveBeenCalledWith(
			ENTITY_ID,
			ROOM_ID,
			12,
		);
	});

	it("propagates a negative extraction decision from the service", async () => {
		const double = makeService({ shouldRun: false });
		const runtime = makeRuntime(double.service, { count: 2 });

		await expect(
			longTermMemoryEvaluator.shouldRun(runContext(runtime, message())),
		).resolves.toBe(false);
		expect(double.shouldRunExtraction).toHaveBeenCalledWith(
			ENTITY_ID,
			ROOM_ID,
			2,
		);
	});
});

describe("longTermMemoryEvaluator.prepare", () => {
	it("throws when no memory service is registered", async () => {
		const runtime = makeRuntime(null);

		await expect(
			longTermMemoryEvaluator.prepare?.(
				promptContext(runtime, message(), {} as never),
			),
		).rejects.toThrow("MemoryService not found");
	});

	it("filters synthetic conversation artifacts and orders genuine turns oldest-first", async () => {
		const double = makeService();
		const rows = [
			message({ createdAt: 2000, content: { text: "later genuine" } }),
			message({
				createdAt: 5000,
				content: { text: "[conversation summary] rolling ledger" },
				metadata: { source: "summary" },
			}),
			message({ createdAt: 1000, content: { text: "earlier genuine" } }),
		];
		const runtime = makeRuntime(double.service, { rows });

		const prepared = await longTermMemoryEvaluator.prepare?.(
			promptContext(runtime, message(), {} as never),
		);

		expect(prepared?.recentMessages.map((row) => row.content.text)).toEqual([
			"earlier genuine",
			"later genuine",
		]);
	});

	it("formats existing memories, falls back to None yet, and floors the fetch limit at one", async () => {
		const populated = makeService({
			existing: [
				longTermRecord(),
				longTermRecord({
					category: LongTermMemoryCategory.EPISODIC,
					content: "climbed a mountain",
					confidence: 0.95,
				}),
			],
		});
		const populatedRuntime = makeRuntime(populated.service, { count: 12 });

		const prepared = await longTermMemoryEvaluator.prepare?.(
			promptContext(populatedRuntime, message(), {} as never),
		);

		expect(prepared?.existingMemories).toBe(
			"[semantic] fact 1 (confidence: 0.9)\n[episodic] climbed a mountain (confidence: 0.95)",
		);
		expect(prepared?.currentMessageCount).toBe(12);
		expect(populated.getLongTermMemories).toHaveBeenCalledWith(ENTITY_ID);

		const empty = makeService({ existing: [] });
		let capturedLimit: number | undefined;
		const emptyRuntime = createMockRuntime({
			countMemories: vi.fn(async () => 0),
			getMemories: vi.fn(async (params: { limit?: number }) => {
				capturedLimit = params.limit;
				return [] as Memory[];
			}),
			getService: vi.fn((type: string) =>
				type === "memory" ? empty.service : null,
			),
		});

		const emptyPrepared = await longTermMemoryEvaluator.prepare?.(
			promptContext(emptyRuntime, message(), {} as never),
		);

		expect(emptyPrepared?.existingMemories).toBe("None yet");
		expect(capturedLimit).toBe(1);
	});
});

describe("longTermMemoryEvaluator.prompt", () => {
	it("renders each speaker through the agent-name and sender-name fallback chain", () => {
		const runtime = makeRuntime(makeService().service);
		const recentMessages = [
			message({
				entityId: MOCK_AGENT_ID,
				content: { text: "I can help with that" },
			}),
			message({
				entityId: OTHER_ENTITY_ID,
				content: { text: "hi", senderName: "Alice" },
			}),
			message({ entityId: OTHER_ENTITY_ID, content: { text: "yo" } }),
			message({
				entityId: OTHER_ENTITY_ID,
				content: { text: "", senderName: "Bob" },
			}),
		];

		const prompt = longTermMemoryEvaluator.prompt(
			promptContext(runtime, message(), {
				memoryService: makeService().service,
				recentMessages,
				existingMemories: "None yet",
				currentMessageCount: 4,
			}),
		);

		const rendered = prompt.split("Recent messages:\n")[1]?.split("\n");
		expect(rendered).toEqual([
			"MockAgent: I can help with that",
			"Alice: hi",
			`${OTHER_ENTITY_ID}: yo`,
			"Bob: [non-text message]",
		]);
	});

	it("embeds the existing-memory block verbatim between its labelled sections", () => {
		const runtime = makeRuntime(makeService().service);

		const prompt = longTermMemoryEvaluator.prompt(
			promptContext(runtime, message(), {
				memoryService: makeService().service,
				recentMessages: [],
				existingMemories: "[procedural] ties a bowline (confidence: 0.99)",
				currentMessageCount: 0,
			}),
		);

		expect(prompt).toContain(
			"Existing long-term memories:\n[procedural] ties a bowline (confidence: 0.99)\n\nRecent messages:",
		);
	});
});

describe("longTermMemoryEvaluator.parse", () => {
	it.each([
		["null", null],
		["a scalar string", "nope"],
		["an array", [1, 2]],
		["a record without a memories array", { memories: "x" }],
	])("returns null for %s", (_label, output) => {
		expect(longTermMemoryEvaluator.parse?.(output)).toBeNull();
	});

	it("normalizes valid entries by trimming content and lowercasing categories", () => {
		expect(
			longTermMemoryEvaluator.parse?.({
				memories: [
					{
						category: "  SEMANTIC ",
						content: "  likes coffee  ",
						confidence: 0.9,
					},
				],
			}),
		).toEqual({
			memories: [
				{
					category: "semantic",
					content: "likes coffee",
					confidence: 0.9,
				},
			],
		});
	});

	it("drops malformed or unknown entries while keeping valid siblings", () => {
		const output = longTermMemoryEvaluator.parse?.({
			memories: [
				42,
				{ category: "unknown", content: "mystery", confidence: 0.9 },
				{ category: "episodic", content: "   ", confidence: 0.9 },
				{ category: "episodic", content: "vague number", confidence: "high" },
				{
					category: "Procedural",
					content: "ties knots",
					confidence: 0.99,
				},
			],
		});

		expect(output).toEqual({
			memories: [
				{
					category: "procedural",
					content: "ties knots",
					confidence: 0.99,
				},
			],
		});
	});

	it("parses an explicitly empty memories array into an empty successful output", () => {
		expect(longTermMemoryEvaluator.parse?.({ memories: [] })).toEqual({
			memories: [],
		});
	});
});

describe("longTermMemoryEvaluator storeLongTermMemory processor", () => {
	function processor() {
		const [first] = longTermMemoryEvaluator.processors ?? [];
		if (!first) throw new Error("storeLongTermMemory processor missing");
		return first;
	}

	async function process(output: {
		memories: Array<{
			category: string;
			content: string;
			confidence: number;
		}>;
		config?: Partial<MemoryConfig>;
	}) {
		const double = makeService({ config: output.config });
		const runtime = makeRuntime(double.service);
		const prepared = {
			memoryService: double.service,
			recentMessages: [],
			existingMemories: "None yet",
			currentMessageCount: 12,
		};

		const result = await processor().process({
			runtime,
			message: message(),
			state: {} as State,
			options: {},
			evaluatorName: longTermMemoryEvaluator.name,
			output,
			prepared,
		});

		return { double, result };
	}

	it("stores only extractions at or above the max(threshold, 0.85) floor", async () => {
		const { double, result } = await process({
			memories: [
				{ category: "semantic", content: "below floor", confidence: 0.84 },
				{ category: "semantic", content: "above floor", confidence: 0.86 },
				{ category: "procedural", content: "certain", confidence: 1 },
			],
		});

		expect(result).toMatchObject({
			success: true,
			values: { longTermStored: 2 },
		});
		expect(double.stored.map((memory) => memory.content)).toEqual([
			"above floor",
			"certain",
		]);
	});

	it("raises the floor above 0.85 when the configured threshold demands it", async () => {
		const { double, result } = await process({
			config: { longTermConfidenceThreshold: 0.95 },
			memories: [
				{ category: "semantic", content: "under", confidence: 0.9 },
				{ category: "semantic", content: "over", confidence: 0.96 },
			],
		});

		expect(result).toMatchObject({
			success: true,
			values: { longTermStored: 1 },
		});
		expect(double.stored.map((memory) => memory.content)).toEqual(["over"]);
	});

	it("still advances the extraction checkpoint when nothing qualifies", async () => {
		const { double, result } = await process({
			config: { longTermConfidenceThreshold: 0.95 },
			memories: [{ category: "semantic", content: "weak", confidence: 0.5 }],
		});

		expect(result).toMatchObject({
			success: true,
			values: { longTermStored: 0 },
		});
		expect(double.setLastExtractionCheckpoint).toHaveBeenCalledWith(
			ENTITY_ID,
			ROOM_ID,
			12,
		);
	});
});

describe("memoryItems registry export", () => {
	it("registers exactly the long-term-memory evaluator", () => {
		expect(memoryItems).toHaveLength(1);
		expect(memoryItems[0]).toBe(longTermMemoryEvaluator);
	});
});
