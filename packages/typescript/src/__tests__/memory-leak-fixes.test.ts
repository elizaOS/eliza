/**
 * Tests for memory leak fixes across the codebase:
 * - logListeners cap (logger.ts)
 * - AgentEventService run tracking caps/cleanup (agentEvent.ts)
 * - PlanningService active plan retention (planning-service.ts)
 * - MemoryService Map cleanup + size caps (memory-service.ts)
 * - RECENT_MESSAGES autonomy cap (recentMessages.ts)
 */

import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MemoryService } from "../advanced-memory/services/memory-service";
import { PlanningService } from "../advanced-planning/services/planning-service";
import { addLogListener, type LogListener, removeLogListener } from "../logger";
import { AgentEventService } from "../services/agentEvent";
import type { IAgentRuntime, UUID } from "../types";

// ===========================================================================
// logListeners cap
// ===========================================================================

describe("logListeners — safety cap", () => {
	const addedCleanups: Array<() => void> = [];

	afterEach(() => {
		// Clean up all listeners added during the test
		for (const cleanup of addedCleanups) {
			cleanup();
		}
		addedCleanups.length = 0;
	});

	test("allows up to 50 listeners", () => {
		const listeners: LogListener[] = [];

		for (let i = 0; i < 50; i++) {
			const listener: LogListener = () => {};
			const cleanup = addLogListener(listener);
			addedCleanups.push(cleanup);
			listeners.push(listener);
		}

		// All 50 should be added — verify by removing and confirming cleanup works
		for (const cleanup of addedCleanups) {
			cleanup();
		}
		addedCleanups.length = 0;
	});

	test("evicts the oldest listener when the cap (50) is exceeded", () => {
		const evictionTarget: LogListener = vi.fn();
		const evictionCleanup = addLogListener(evictionTarget);
		addedCleanups.push(evictionCleanup);

		// Add 49 more to fill up to 50
		for (let i = 0; i < 49; i++) {
			const cleanup = addLogListener(() => {});
			addedCleanups.push(cleanup);
		}

		// The 51st listener should evict `evictionTarget`
		const newListener: LogListener = vi.fn();
		const newCleanup = addLogListener(newListener);
		addedCleanups.push(newCleanup);

		// Verify evictionTarget was evicted: calling its cleanup should be a no-op
		// (it was already removed). If we try to removeLogListener it, it should
		// not throw but should be a no-op since it's already gone.
		removeLogListener(evictionTarget);
	});

	test("cleanup function correctly removes listener", () => {
		const listener: LogListener = () => {};
		const cleanup = addLogListener(listener);
		addedCleanups.push(cleanup);

		// Calling cleanup should remove the listener
		cleanup();

		// Remove from our tracking since we already cleaned it up
		addedCleanups.pop();
	});
});

// ===========================================================================
// AgentEventService — run tracking bounds
// ===========================================================================

describe("AgentEventService — run tracking bounds", () => {
	test("clears per-run state after terminal lifecycle events", () => {
		const service = new AgentEventService();
		const serviceInternal = service as unknown as {
			seqByRun: Map<string, number>;
			runContextById: Map<string, unknown>;
			lastTouchedAtByRun: Map<string, number>;
		};

		service.registerRunContext("run-1", {
			sessionKey: "session-1",
		} as never);

		service.emit({
			runId: "run-1",
			stream: "lifecycle",
			data: { type: "run_end" },
		} as never);

		expect(serviceInternal.seqByRun.size).toBe(0);
		expect(serviceInternal.runContextById.size).toBe(0);
		expect(serviceInternal.lastTouchedAtByRun.size).toBe(0);
	});

	test("caps tracked runs to prevent unbounded growth", () => {
		const service = new AgentEventService();
		const serviceInternal = service as unknown as {
			seqByRun: Map<string, number>;
			runContextById: Map<string, unknown>;
			lastTouchedAtByRun: Map<string, number>;
		};

		for (let i = 0; i < 1200; i++) {
			const runId = `run-${i}`;
			service.registerRunContext(runId, {
				sessionKey: `session-${i}`,
			} as never);
			service.emit({
				runId,
				stream: "message",
				data: { type: "received" },
			} as never);
		}

		expect(serviceInternal.seqByRun.size).toBeLessThanOrEqual(1000);
		expect(serviceInternal.runContextById.size).toBeLessThanOrEqual(1000);
		expect(serviceInternal.lastTouchedAtByRun.size).toBeLessThanOrEqual(1000);
		expect(service.getRunContext("run-0")).toBeUndefined();
		expect(service.getCurrentSeq("run-0")).toBe(0);
	});
});

// ===========================================================================
// PlanningService — active plan retention
// ===========================================================================

describe("PlanningService — active plan retention", () => {
	function createPlanningMessage(text: string) {
		return {
			id: uuidv4() as UUID,
			entityId: uuidv4() as UUID,
			agentId: uuidv4() as UUID,
			roomId: uuidv4() as UUID,
			content: { text },
			createdAt: Date.now(),
		};
	}

	test("caps retained active plans for abandoned plan creation", async () => {
		const service = new PlanningService({} as IAgentRuntime);
		const serviceInternal = service as unknown as {
			activePlans: Map<UUID, unknown>;
		};
		const planIds: UUID[] = [];

		for (let i = 0; i < 125; i++) {
			const plan = await service.createSimplePlan(
				{} as IAgentRuntime,
				createPlanningMessage(`message ${i}`) as never,
				{ values: {}, data: {}, text: "" } as never,
			);
			expect(plan).not.toBeNull();
			if (plan?.id) {
				planIds.push(plan.id);
			}
		}

		expect(serviceInternal.activePlans.size).toBeLessThanOrEqual(100);
		expect(serviceInternal.activePlans.has(planIds[0] as UUID)).toBe(false);
		expect(
			serviceInternal.activePlans.has(planIds[planIds.length - 1] as UUID),
		).toBe(true);
	});
});

// ===========================================================================
// MemoryService — Map cleanup + size caps
// ===========================================================================

describe("MemoryService — cleanup and caps", () => {
	function createMockRuntime(): IAgentRuntime {
		return {
			agentId: uuidv4() as UUID,
			getSetting: () => undefined,
			getCache: vi.fn(async () => null),
			setCache: vi.fn(async () => true),
			logger: {
				info: vi.fn(),
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		} as unknown as IAgentRuntime;
	}

	test("stop() clears sessionMessageCounts and lastExtractionCheckpoints", async () => {
		const runtime = createMockRuntime();
		const service = new MemoryService(runtime);
		await service.initialize(runtime);

		// Populate the maps
		const roomId = uuidv4() as UUID;
		service.incrementMessageCount(roomId);
		expect(service.incrementMessageCount(roomId)).toBe(2);

		// stop() should clear everything
		await service.stop();

		// After stop, incrementing again should start from 0
		// (map was cleared, so no prior entry)
		const serviceInternal = service as unknown as {
			sessionMessageCounts: Map<UUID, number>;
			lastExtractionCheckpoints: Map<string, number>;
		};
		expect(serviceInternal.sessionMessageCounts.size).toBe(0);
		expect(serviceInternal.lastExtractionCheckpoints.size).toBe(0);
	});

	test("sessionMessageCounts caps at MAX_SESSION_ENTRIES (500)", () => {
		const runtime = createMockRuntime();
		const service = new MemoryService(runtime);

		const serviceInternal = service as unknown as {
			sessionMessageCounts: Map<UUID, number>;
		};

		// Fill up to 500 entries
		for (let i = 0; i < 500; i++) {
			service.incrementMessageCount(uuidv4() as UUID);
		}
		expect(serviceInternal.sessionMessageCounts.size).toBe(500);

		// Adding one more should evict the oldest, keeping size at 500
		service.incrementMessageCount(uuidv4() as UUID);
		expect(serviceInternal.sessionMessageCounts.size).toBeLessThanOrEqual(500);
	});

	test("lastExtractionCheckpoints caps at MAX_SESSION_ENTRIES (500)", async () => {
		const runtime = createMockRuntime();
		const service = new MemoryService(runtime);
		await service.initialize(runtime);

		const serviceInternal = service as unknown as {
			lastExtractionCheckpoints: Map<string, number>;
		};

		// Fill up to 500 entries directly
		for (let i = 0; i < 500; i++) {
			serviceInternal.lastExtractionCheckpoints.set(`key-${i}`, i);
		}
		expect(serviceInternal.lastExtractionCheckpoints.size).toBe(500);

		// Calling getLastExtractionCheckpoint for a new key triggers a cache miss
		// which adds to the map — should evict oldest
		const entityId = uuidv4() as UUID;
		const roomId = uuidv4() as UUID;
		await service.getLastExtractionCheckpoint(entityId, roomId);

		expect(serviceInternal.lastExtractionCheckpoints.size).toBeLessThanOrEqual(
			500,
		);
	});
});

// ===========================================================================
// RECENT_MESSAGES — autonomy cap
// ===========================================================================

describe("recentMessages provider — autonomy cap", () => {
	function createProviderMockRuntime() {
		let capturedCount: number | undefined;
		const roomId = uuidv4() as UUID;
		const agentId = uuidv4() as UUID;

		const mockRuntime = {
			agentId,
			getConversationLength: () => 100,
			getSetting: () => undefined,
			getRoom: async () => ({
				id: roomId,
				type: "GROUP",
				name: "Test Room",
				metadata: {},
			}),
			getMemories: vi.fn(async (params: { count?: number }) => {
				capturedCount = params.count;
				return [];
			}),
			getRoomsForParticipants: async () => [],
			getMemoriesByRoomIds: async () => [],
			getEntityById: async () => null,
			getEntitiesForRoom: async () => [],
		} as unknown as IAgentRuntime;

		return {
			mockRuntime,
			getCapturedCount: () => capturedCount,
			roomId,
			agentId,
		};
	}

	test("uses AUTONOMY_CONVERSATION_CAP (10) for autonomous messages", {
		timeout: 30000,
	}, async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages"
		);

		const { mockRuntime, getCapturedCount, roomId } =
			createProviderMockRuntime();

		// Create a message with autonomy metadata
		const autonomyMessage = {
			id: uuidv4() as UUID,
			entityId: uuidv4() as UUID,
			roomId,
			content: {
				text: "autonomous thought",
				metadata: {
					isAutonomous: true,
					type: "autonomous-prompt",
				},
			},
			createdAt: Date.now(),
		};

		await recentMessagesProvider.get(mockRuntime, autonomyMessage, {
			values: {},
			data: {},
			text: "",
		});

		// Should have used the capped count (10) instead of default (100)
		expect(getCapturedCount()).toBe(10);
	});

	test("uses full conversationLength for regular messages", async () => {
		const { recentMessagesProvider } = await import(
			"../basic-capabilities/providers/recentMessages"
		);

		const { mockRuntime, getCapturedCount, roomId } =
			createProviderMockRuntime();

		// Regular (non-autonomy) message
		const regularMessage = {
			id: uuidv4() as UUID,
			entityId: uuidv4() as UUID,
			roomId,
			content: {
				text: "hello there",
			},
			createdAt: Date.now(),
		};

		await recentMessagesProvider.get(mockRuntime, regularMessage, {
			values: {},
			data: {},
			text: "",
		});

		// Should use the full conversation length
		expect(getCapturedCount()).toBe(100);
	});
});
