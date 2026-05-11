import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerificationRoomBridgeService } from "../verification-room-bridge.ts";

/**
 * Minimal SwarmCoordinator-shaped stub. Only `subscribe` is exercised
 * by the bridge.
 */
function makeCoordinator() {
	const listeners = new Set<(event: unknown) => void>();
	return {
		subscribe: (listener: (event: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		__emit: (event: unknown) => {
			for (const l of listeners) l(event);
		},
		__listenerCount: () => listeners.size,
	};
}

function makeRuntime(initialServices: Record<string, unknown>) {
	const services = { ...initialServices };
	return {
		runtime: {
			getService: vi.fn((name: string) => services[name] ?? null),
			createMemory: vi.fn(async () => ({ id: "mem-stub" })),
			agentId: "agent-1",
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		} as unknown as IAgentRuntime,
		setService: (name: string, instance: unknown) => {
			services[name] = instance;
		},
	};
}

describe("VerificationRoomBridgeService — boot-order retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("attaches immediately when SwarmCoordinator is available at start()", async () => {
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });

		const service = await VerificationRoomBridgeService.start(runtime);

		expect(coordinator.__listenerCount()).toBe(1);
		await service.stop();
		expect(coordinator.__listenerCount()).toBe(0);
	});

	it("retries until SwarmCoordinator is registered, then subscribes once", async () => {
		const coordinator = makeCoordinator();
		const { runtime, setService } = makeRuntime({});

		const service = await VerificationRoomBridgeService.start(runtime);

		// First attach attempt failed — no service yet, no subscriber.
		expect(coordinator.__listenerCount()).toBe(0);

		// Service becomes available later; advance the retry timer.
		setService("SWARM_COORDINATOR", coordinator);
		await vi.advanceTimersByTimeAsync(500);

		expect(coordinator.__listenerCount()).toBe(1);
		await service.stop();
	});

	it("gives up quietly after ATTACH_MAX_RETRIES without binding twice", async () => {
		const coordinator = makeCoordinator();
		const { runtime, setService } = makeRuntime({});

		const service = await VerificationRoomBridgeService.start(runtime);

		// Drain the entire retry budget: 60 retries × 500ms = 30s.
		await vi.advanceTimersByTimeAsync(31_000);

		// Service eventually shows up AFTER giving up. Bridge must NOT
		// subscribe — the retry loop already terminated.
		setService("SWARM_COORDINATOR", coordinator);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(coordinator.__listenerCount()).toBe(0);

		await service.stop();
	});

	it("stop() cancels a pending retry timer", async () => {
		const coordinator = makeCoordinator();
		const { runtime, setService } = makeRuntime({});

		const service = await VerificationRoomBridgeService.start(runtime);

		// Tear down BEFORE the service becomes available.
		await service.stop();

		// Now register the coordinator and advance time. A leaked timer
		// would re-attach and increment the listener count; a proper
		// cancel keeps it at zero.
		setService("SWARM_COORDINATOR", coordinator);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(coordinator.__listenerCount()).toBe(0);
	});
});
