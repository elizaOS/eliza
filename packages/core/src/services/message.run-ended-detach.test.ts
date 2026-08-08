/**
 * Residual #17072: early-exit RUN_ENDED must not block handleMessage return.
 * A slow lifecycle observer on RUN_ENDED used to sit on the await path for
 * self/mute/off exits; it now rides the post-delivery tracker so the caller
 * returns immediately and shutdown can still drain the work.
 */
import { describe, expect, it, vi } from "vitest";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import { EventType } from "../types/events";
import type { IAgentRuntime, Memory, UUID } from "../types/index";
import { DefaultMessageService } from "./message";
import {
	drainPostDeliveryTasks,
	pendingPostDeliveryTaskCount,
} from "./post-delivery-task-tracker.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const RUN_ID = "00000000-0000-0000-0000-0000000000f1" as UUID;

describe("DefaultMessageService — RUN_ENDED post-delivery detach", () => {
	it("returns from a self-message exit before a slow RUN_ENDED handler finishes", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let runEndedStarted = false;
		let runEndedFinished = false;
		const emitEvent = vi.fn(async (event: string) => {
			if (event === EventType.RUN_ENDED) {
				runEndedStarted = true;
				await gate;
				runEndedFinished = true;
			}
		});
		const runtime = {
			agentId: AGENT_ID,
			character: { name: "Eliza", username: "eliza" },
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			stateCache: new Map(),
			turnControllers: new TurnControllerRegistry(),
			emitEvent,
			reportError: vi.fn(),
			useModel: vi.fn(async () => {
				throw new Error("useModel must not run on self-message exit");
			}),
			getService: () => null,
			getSetting: () => undefined,
			startRun: () => RUN_ID,
			runActionsByMode: async () => undefined,
			getMemoryById: async () => null,
			createMemory: async (memory: Memory) => memory.id,
			queueEmbeddingGeneration: async () => undefined,
			getParticipantUserState: async () => null,
			getRoom: async () => null,
			getWorld: async () => null,
		} as unknown as IAgentRuntime;

		const selfMessage = {
			id: "00000000-0000-0000-0000-0000000000b1" as UUID,
			entityId: AGENT_ID, // same as agent → self skip
			agentId: AGENT_ID,
			roomId: "00000000-0000-0000-0000-0000000000d1" as UUID,
			content: { text: "loopback", source: "test" },
		} as unknown as Memory;

		const service = new DefaultMessageService();
		const started = Date.now();
		const result = await service.handleMessage(runtime, selfMessage);
		const elapsedMs = Date.now() - started;

		expect(result.didRespond).toBe(false);
		expect(result.mode).toBe("none");
		// Causality: at the moment handleMessage returned, the gated RUN_ENDED
		// handler cannot have finished — the gate is still closed. This is the
		// real detach contract; if RUN_ENDED were back on the await path the
		// handleMessage call above would deadlock on the gate instead.
		expect(runEndedFinished).toBe(false);
		// Deadline assertions on loaded CI runners need generous margins: the
		// worker can lose seconds of wall clock to CPU contention. 5s is still
		// far below the forever-pending gate a regression would await.
		expect(elapsedMs).toBeLessThan(5_000);
		expect(pendingPostDeliveryTaskCount(runtime)).toBeGreaterThan(0);
		// The detached handler starts on its own microtask; under load it may
		// not have begun by the time handleMessage returns. Wait for the start
		// signal instead of asserting it synchronously.
		await vi.waitFor(() => {
			expect(runEndedStarted).toBe(true);
		});
		expect(runEndedFinished).toBe(false);

		release();
		await drainPostDeliveryTasks(runtime);
		expect(runEndedFinished).toBe(true);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
		const ended = emitEvent.mock.calls
			.filter(([event]) => event === EventType.RUN_ENDED)
			.map(([, payload]) => (payload as { status: string }).status);
		expect(ended).toContain("self");
	});
});
