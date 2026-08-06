/** Verifies extraction checkpoints distinguish an absent value from cache I/O failure. */
import { describe, expect, it, vi } from "vitest";
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
});
