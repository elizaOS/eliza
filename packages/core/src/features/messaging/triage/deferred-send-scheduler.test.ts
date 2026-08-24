/**
 * Unit tests for deferred-send-scheduler: validates scheduler registration,
 * duplicate rejection with ElizaError, retrieval, and teardown cleanup.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../../../errors.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import {
	type DeferredMessageScheduler,
	getDeferredMessageScheduler,
	registerDeferredMessageScheduler,
} from "./deferred-send-scheduler.ts";

describe("deferred-send-scheduler", () => {
	it("returns null when no scheduler is registered", () => {
		const runtime = {} as IAgentRuntime;
		expect(getDeferredMessageScheduler(runtime)).toBeNull();
	});

	it("registers and retrieves scheduler for a runtime", () => {
		const runtime = {} as IAgentRuntime;
		const mockScheduler: DeferredMessageScheduler = {
			schedule: async () => ({
				scheduledId: "sched-1",
				scheduledForMs: Date.now() + 10000,
				commit: {
					kind: "durable",
					id: "commit-1",
					committedAt: new Date().toISOString(),
					idempotencyKey: "idem-1",
					replayed: false,
				},
			}),
		};

		const unregister = registerDeferredMessageScheduler(runtime, mockScheduler);
		expect(getDeferredMessageScheduler(runtime)).toBe(mockScheduler);

		unregister();
		expect(getDeferredMessageScheduler(runtime)).toBeNull();
	});

	it("throws fatal ElizaError on duplicate registration", () => {
		const runtime = {} as IAgentRuntime;
		const mockScheduler: DeferredMessageScheduler = {
			schedule: async () => ({}) as any,
		};

		registerDeferredMessageScheduler(runtime, mockScheduler);

		expect(() => {
			registerDeferredMessageScheduler(runtime, mockScheduler);
		}).toThrow(ElizaError);

		try {
			registerDeferredMessageScheduler(runtime, mockScheduler);
		} catch (err) {
			expect((err as ElizaError).code).toBe(
				"DEFERRED_MESSAGE_SCHEDULER_DUPLICATE",
			);
			expect((err as ElizaError).severity).toBe("fatal");
		}
	});
});
