/** Verifies extraction checkpoints distinguish an absent value from cache I/O failure. */
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../../logger.ts";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { UUID } from "../../../types/primitives.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { MemoryService } from "./memory-service.ts";

const ENTITY_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000f1" as UUID;

describe("MemoryService extraction checkpoints", () => {
	it("treats a missing checkpoint as the initial zero value", async () => {
		const getCache = vi.fn<IAgentRuntime["getCache"]>(async () => undefined);
		const service = new MemoryService(createMockRuntime({ getCache }));

		await expect(
			service.getLastExtractionCheckpoint(ENTITY_ID, ROOM_ID),
		).resolves.toBe(0);
		await expect(
			service.getLastExtractionCheckpoint(ENTITY_ID, ROOM_ID),
		).resolves.toBe(0);
		expect(getCache).toHaveBeenCalledTimes(1);
	});

	it("propagates checkpoint read failures instead of fabricating zero", async () => {
		const failure = new Error("cache unavailable");
		const getCache = vi.fn<IAgentRuntime["getCache"]>(async () => {
			throw failure;
		});
		const service = new MemoryService(createMockRuntime({ getCache }));

		await expect(
			service.getLastExtractionCheckpoint(ENTITY_ID, ROOM_ID),
		).rejects.toBe(failure);
	});

	it("does not cache a checkpoint whose durable write failed", async () => {
		const failure = new Error("cache write failed");
		const setCache = vi.fn<IAgentRuntime["setCache"]>(async () => {
			throw failure;
		});
		const getCache = vi.fn<IAgentRuntime["getCache"]>(async () => 7);
		const service = new MemoryService(
			createMockRuntime({ getCache, setCache }),
		);

		await expect(
			service.setLastExtractionCheckpoint(ENTITY_ID, ROOM_ID, 42),
		).rejects.toBe(failure);
		await expect(
			service.getLastExtractionCheckpoint(ENTITY_ID, ROOM_ID),
		).resolves.toBe(7);
		expect(getCache).toHaveBeenCalledTimes(1);
	});

	it("does not let an older cache read replace a concurrent checkpoint write", async () => {
		let resolveCacheRead: ((value: number) => void) | undefined;
		const getCache = vi.fn<IAgentRuntime["getCache"]>(
			() =>
				new Promise<number>((resolve) => {
					resolveCacheRead = resolve;
				}),
		);
		const setCache = vi.fn<IAgentRuntime["setCache"]>(async () => true);
		const service = new MemoryService(
			createMockRuntime({ getCache, setCache }),
		);

		const pendingRead = service.getLastExtractionCheckpoint(ENTITY_ID, ROOM_ID);
		await service.setLastExtractionCheckpoint(ENTITY_ID, ROOM_ID, 42);
		resolveCacheRead?.(7);

		await expect(pendingRead).resolves.toBe(42);
		await expect(
			service.getLastExtractionCheckpoint(ENTITY_ID, ROOM_ID),
		).resolves.toBe(42);
		expect(getCache).toHaveBeenCalledTimes(1);
	});
});

describe("MemoryService extraction interval configuration", () => {
	const DEFAULT_INTERVAL = 10;

	/** Initialize a service with MEMORY_EXTRACTION_INTERVAL set to `raw`. */
	async function intervalFor(raw: string | number | boolean): Promise<number> {
		const runtime = createMockRuntime({
			getCache: vi.fn<IAgentRuntime["getCache"]>(async () => 0),
			setCache: vi.fn(async () => true),
			getSetting: (key: string) =>
				key === "MEMORY_EXTRACTION_INTERVAL" ? raw : undefined,
			// No storage backend: initialize() resolves config either way, and
			// these assertions are about the config value, not the provider.
			hasService: () => false,
			getService: () => null,
		});
		const service = new MemoryService(runtime);
		await service.initialize(runtime);
		return (
			service as unknown as {
				memoryConfig: { longTermExtractionInterval: number };
			}
		).memoryConfig.longTermExtractionInterval;
	}

	it("ignores a fractional interval that would truncate to a zero divisor", async () => {
		// parseInt("0.5") is 0, and shouldRunExtraction computes
		//   Math.floor(count / interval) * interval
		// so the checkpoint became NaN. Every comparison against NaN is false,
		// so extraction silently never ran again.
		await expect(intervalFor("0.5")).resolves.toBe(DEFAULT_INTERVAL);
	});

	it("ignores a negative interval that would run extraction every message", async () => {
		// A negative divisor makes the checkpoint exceed the last one on nearly
		// every call — the mirror failure of the zero case.
		await expect(intervalFor("-5")).resolves.toBe(DEFAULT_INTERVAL);
	});

	it("ignores a trailing-garbage interval", async () => {
		// parseInt("30junk") is 30 — a cadence three times the default, taken
		// as deliberate configuration.
		await expect(intervalFor("30junk")).resolves.toBe(DEFAULT_INTERVAL);
	});

	it("ignores an interval beyond the safe integer range", async () => {
		await expect(intervalFor("9007199254740993")).resolves.toBe(
			DEFAULT_INTERVAL,
		);
	});

	it("warns and keeps the default for a defined numeric zero", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

		await expect(intervalFor(0)).resolves.toBe(DEFAULT_INTERVAL);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('MEMORY_EXTRACTION_INTERVAL="0"'),
		);
		warn.mockRestore();
	});

	it("still honours a clean interval, including a signed one", async () => {
		await expect(intervalFor("50")).resolves.toBe(50);
		// `parseInt` accepted "+50"; rejecting it would be a regression.
		await expect(intervalFor("+50")).resolves.toBe(50);
	});

	it("keeps extraction running on a valid interval", async () => {
		// End-to-end: the resolved interval still drives shouldRunExtraction.
		const runtime = createMockRuntime({
			getCache: vi.fn<IAgentRuntime["getCache"]>(async () => 0),
			setCache: vi.fn(async () => true),
			getSetting: (key: string) =>
				key === "MEMORY_EXTRACTION_INTERVAL" ? "50" : undefined,
			hasService: () => false,
			getService: () => null,
		});
		const service = new MemoryService(runtime);
		await service.initialize(runtime);
		await expect(
			service.shouldRunExtraction(ENTITY_ID, ROOM_ID, 100),
		).resolves.toBe(true);
	});
});

describe("MemoryService searchLongTermMemories similarity comparator", () => {
	it("maintains strict total ordering when similarities evaluate to non-finite or zero values", async () => {
		const candidates = [
			{
				id: "00000000-0000-0000-0000-000000000001" as UUID,
				agentId: ENTITY_ID,
				entityId: ENTITY_ID,
				type: "fact" as const,
				content: "first",
				embedding: [0.8, 0.6],
				createdAt: 1000,
				updatedAt: 1000,
			},
			{
				id: "00000000-0000-0000-0000-000000000002" as UUID,
				agentId: ENTITY_ID,
				entityId: ENTITY_ID,
				type: "fact" as const,
				content: "second",
				embedding: [0.6, 0.8],
				createdAt: 2000,
				updatedAt: 2000,
			},
			{
				id: "00000000-0000-0000-0000-000000000003" as UUID,
				agentId: ENTITY_ID,
				entityId: ENTITY_ID,
				type: "fact" as const,
				content: "third",
				embedding: [0.0, 0.0], // zero-norm vector
				createdAt: 3000,
				updatedAt: 3000,
			},
		];

		const mockStorage = {
			storeLongTermMemory: vi.fn(),
			storeSessionSummary: vi.fn(),
			getLongTermMemories: vi.fn(async () => candidates),
		};

		const runtime = createMockRuntime({
			getSetting: vi.fn((key: string) =>
				key === "MEMORY_LONG_TERM_VECTOR_SEARCH_ENABLED" ||
				key === "MEMORY_VECTOR_SEARCH_ENABLED"
					? "true"
					: undefined,
			),
			hasService: (name: string) => name === "memoryStorage",
			getService: (name: string) =>
				name === "memoryStorage" ? mockStorage : null,
			getServiceLoadPromise: vi.fn(async () => mockStorage),
		});
		const service = new MemoryService(runtime);
		await service.initialize(runtime);
		(
			service as unknown as {
				memoryConfig: { longTermVectorSearchEnabled: boolean };
			}
		).memoryConfig.longTermVectorSearchEnabled = true;

		const results = await service.searchLongTermMemories(
			ENTITY_ID,
			[0.8, 0.6],
			10,
			0,
		);

		expect(results).toHaveLength(3);
		expect(results[0]?.id).toBe("00000000-0000-0000-0000-000000000001");
		expect(results[1]?.id).toBe("00000000-0000-0000-0000-000000000002");
		expect(results[2]?.id).toBe("00000000-0000-0000-0000-000000000003");
	});
});
