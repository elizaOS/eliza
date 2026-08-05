/**
 * Pure unit tests for the shutdown-drain turn registry (shutdown-drain.ts):
 * draining an in-flight turn, returning promptly with nothing tracked, and
 * abandoning + reconciling a turn that outlives the bounded timeout instead
 * of hanging. Real (short) timers — deterministic, no fake-timer plumbing
 * needed since every scenario resolves in single-digit milliseconds.
 */
import { describe, expect, it, vi } from "vitest";
import {
	createTurnDrainRegistry,
	DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS,
} from "../shutdown-drain.ts";
import type { StatusReactionController } from "../status-reactions.ts";

function makeController(): StatusReactionController & {
	abandon: ReturnType<typeof vi.fn>;
} {
	let resolveFinished: () => void = () => {};
	const whenFinished = new Promise<void>((resolve) => {
		resolveFinished = resolve;
	});
	return {
		setQueued: vi.fn(),
		setThinking: vi.fn(),
		setDone: vi.fn(() => resolveFinished()),
		setError: vi.fn(() => resolveFinished()),
		abandon: vi.fn(() => resolveFinished()),
		whenFinished,
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createTurnDrainRegistry", () => {
	it("exposes the shutdown drain timeout as an explicit bounded constant", () => {
		expect(DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS).toBeGreaterThan(0);
		expect(Number.isFinite(DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS)).toBe(true);
	});

	it("drains an in-flight turn that resolves before the timeout", async () => {
		const registry = createTurnDrainRegistry();
		const controller = makeController();
		const turn = delay(5);

		registry.trackTurn("msg-1", turn);
		registry.trackStatusReaction("msg-1", controller);
		expect(registry.pendingCount()).toBe(1);

		const result = await registry.drain(200);

		expect(result.observedCount).toBe(1);
		expect(result.abandonedMessageIds).toEqual([]);
		// The turn finished on its own; the drain must not force-reconcile a
		// controller that never needed reconciling.
		expect(controller.abandon).not.toHaveBeenCalled();
		expect(registry.pendingCount()).toBe(0);
	});

	it("returns promptly when nothing is in flight", async () => {
		const registry = createTurnDrainRegistry();

		const start = Date.now();
		const result = await registry.drain(DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS);
		const elapsedMs = Date.now() - start;

		expect(result).toEqual({ observedCount: 0, abandonedMessageIds: [] });
		// Must not wait anywhere near the timeout — a well-behaved drain with
		// no tracked turns resolves on the current tick, not after a timer.
		expect(elapsedMs).toBeLessThan(DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS / 10);
	});

	it("abandons and reconciles a turn that outlives the drain timeout, without hanging", async () => {
		const registry = createTurnDrainRegistry();
		const controller = makeController();
		// Deliberately never settles: exercises the abandon path, not the
		// drain-succeeds path.
		const hungTurn = new Promise<void>(() => undefined);

		registry.trackTurn("msg-hung", hungTurn);
		registry.trackStatusReaction("msg-hung", controller);

		const start = Date.now();
		const result = await registry.drain(20);
		const elapsedMs = Date.now() - start;

		expect(result.observedCount).toBe(1);
		expect(result.abandonedMessageIds).toEqual(["msg-hung"]);
		expect(controller.abandon).toHaveBeenCalledTimes(1);
		// Bounded: the call returned close to the 20ms bound, not left hanging
		// on the promise that never resolves.
		expect(elapsedMs).toBeLessThan(500);
	});

	it("does not abandon a turn that has no status-reaction controller", async () => {
		const registry = createTurnDrainRegistry();
		const hungTurn = new Promise<void>(() => undefined);

		registry.trackTurn("msg-no-reaction", hungTurn);

		const result = await registry.drain(20);

		expect(result.abandonedMessageIds).toEqual(["msg-no-reaction"]);
	});

	it("tracks a status reaction registered before the turn promise itself", async () => {
		// messages.ts's registration order is trackTurn then
		// trackStatusReaction, but the registry must not assume that order.
		const registry = createTurnDrainRegistry();
		const controller = makeController();
		const hungTurn = new Promise<void>(() => undefined);

		registry.trackStatusReaction("msg-reversed", controller);
		registry.trackTurn("msg-reversed", hungTurn);

		const result = await registry.drain(20);

		expect(result.abandonedMessageIds).toEqual(["msg-reversed"]);
		expect(controller.abandon).toHaveBeenCalledTimes(1);
	});

	it("only reports turns still pending at the timeout, not ones that settled just in time", async () => {
		const registry = createTurnDrainRegistry();
		const fastController = makeController();
		const slowController = makeController();

		registry.trackTurn("msg-fast", delay(1));
		registry.trackStatusReaction("msg-fast", fastController);
		registry.trackTurn("msg-slow", new Promise<void>(() => undefined));
		registry.trackStatusReaction("msg-slow", slowController);

		const result = await registry.drain(50);

		expect(result.observedCount).toBe(2);
		expect(result.abandonedMessageIds).toEqual(["msg-slow"]);
		expect(fastController.abandon).not.toHaveBeenCalled();
		expect(slowController.abandon).toHaveBeenCalledTimes(1);
	});
	it("clears the drain timer once the turns settle, so a clean drain does not hold the event loop (#17749 review)", async () => {
		// A drain that wins the race must not leave an armed timer behind: an
		// active Node timer keeps the event loop alive, so a shutdown that
		// LOOKS instant in the logs still delays process exit by the full
		// timeout. Caught in review by krutftw on the first head.
		const registry = createTurnDrainRegistry();
		const armed = new Set<ReturnType<typeof setTimeout>>();
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: () => void,
			ms?: number,
		) => {
			const handle = realSetTimeout(fn, ms);
			armed.add(handle);
			return handle;
		}) as typeof globalThis.setTimeout);
		const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
			handle: ReturnType<typeof setTimeout>,
		) => {
			armed.delete(handle);
			realClearTimeout(handle);
		}) as typeof globalThis.clearTimeout);

		try {
			let finish: () => void = () => undefined;
			registry.trackTurn(
				"msg-fast",
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
			);
			const drained = registry.drain(60_000);
			finish();
			const result = await drained;

			expect(result.abandonedMessageIds).toEqual([]);
			// The race is over; nothing may still be armed.
			expect(armed.size).toBe(0);
			expect(clearSpy).toHaveBeenCalled();
		} finally {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});
});
