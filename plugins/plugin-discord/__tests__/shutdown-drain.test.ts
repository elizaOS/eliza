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
		// A real turn reconciles its own reaction on the way out (setDone), so
		// the fixture must too — a handler that settles while its reaction stays
		// pending forever is the STRANDED case, covered separately below.
		const turn = delay(5).then(() => {
			controller.setDone();
		});

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

		expect(result).toEqual({
			observedCount: 0,
			timedOut: false,
			unfinishedMessageIds: [],
			abandonedMessageIds: [],
		});
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

	it("reports a timeout for a hung turn that has no status-reaction controller (#17749 review)", async () => {
		// The shape @lalalune found: status reactions are scope-gated, so on a
		// typical server most turns have no controller. Such a turn can hang
		// through the entire bound while contributing nothing to
		// `abandonedMessageIds` — and the caller, branching on that array, logged
		// "Drained N in-flight turn(s) before shutdown" for a shutdown that timed
		// out and dropped the work. `timedOut` and `unfinishedMessageIds` are the
		// signals that survive a missing controller.
		const registry = createTurnDrainRegistry();
		const hungTurn = new Promise<void>(() => undefined);

		registry.trackTurn("msg-no-reaction", hungTurn);

		const result = await registry.drain(20);

		expect(result.timedOut).toBe(true);
		expect(result.unfinishedMessageIds).toEqual(["msg-no-reaction"]);
		expect(result.observedCount).toBe(1);
		// Still nothing to reconcile — the turn never had a reaction — so this
		// array stays empty. That is exactly why it cannot carry the verdict.
		expect(result.abandonedMessageIds).toEqual([]);
	});

	it("reports a clean drain as not timed out, so the caller can log success on that alone", async () => {
		const registry = createTurnDrainRegistry();

		registry.trackTurn("msg-clean", delay(1));
		const result = await registry.drain(200);

		expect(result.timedOut).toBe(false);
		expect(result.unfinishedMessageIds).toEqual([]);
		expect(result.observedCount).toBe(1);
	});

	it("separates dropped work from reconciled reactions when both occur", async () => {
		// `unfinishedMessageIds` answers "what work was dropped";
		// `abandonedMessageIds` answers "which reactions did we have to force".
		// They are different questions and a turn can appear in either, both, or
		// neither.
		const registry = createTurnDrainRegistry();
		const controller = makeController();

		// Handler still running AND a live reaction: appears in both.
		registry.trackTurn("msg-both", new Promise<void>(() => undefined));
		registry.trackStatusReaction("msg-both", controller);
		// Handler still running, no reaction: dropped work only.
		registry.trackTurn("msg-work-only", new Promise<void>(() => undefined));

		const result = await registry.drain(20);

		expect(result.timedOut).toBe(true);
		expect([...result.unfinishedMessageIds].sort()).toEqual([
			"msg-both",
			"msg-work-only",
		]);
		expect(result.abandonedMessageIds).toEqual(["msg-both"]);
	});

	it("leaves no permanent residue when a turn dies without driving its reaction terminal (#17749 review)", async () => {
		// @lalalune's leak: the previous registry retired an entry only once BOTH
		// halves finished, so a throw that skipped the controller's terminal
		// transition pinned the entry for the process lifetime and made every
		// later stop() burn the full drain bound on it. The halves now retire
		// independently, and the first drain forces the orphaned reaction
		// terminal — so the residue is one bounded drain, not forever.
		const registry = createTurnDrainRegistry();
		const controller = makeController();

		// A handler that rejects and never reconciles its own reaction.
		registry.trackTurn("msg-orphan", Promise.reject(new Error("turn blew up")));
		registry.trackStatusReaction("msg-orphan", controller);
		await delay(10);

		const first = await registry.drain(20);
		expect(first.abandonedMessageIds).toEqual(["msg-orphan"]);
		expect(controller.abandon).toHaveBeenCalledTimes(1);

		// The orphan is gone: nothing tracked, and a second drain returns
		// immediately instead of burning the bound again.
		expect(registry.pendingCount()).toBe(0);
		const start = Date.now();
		const second = await registry.drain(5_000);
		expect(second).toEqual({
			observedCount: 0,
			timedOut: false,
			unfinishedMessageIds: [],
			abandonedMessageIds: [],
		});
		expect(Date.now() - start).toBeLessThan(500);
	});

	it("does not let an older promise retire a re-registered turn under the same id (#17749 review)", async () => {
		// @lalalune's aliasing note. The previous shape mutated one shared entry
		// object, so the older promise's `.finally` flipped `handlerSettled` for
		// the NEWER turn and could retire it early. Discord message ids are
		// unique, so this is defence rather than an observed failure — but it was
		// unguarded.
		const registry = createTurnDrainRegistry();
		let finishFirst: () => void = () => undefined;
		const first = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});

		registry.trackTurn("msg-dup", first);
		registry.trackTurn("msg-dup", new Promise<void>(() => undefined));

		// Settle the SUPERSEDED promise. The live turn must remain tracked.
		finishFirst();
		await delay(10);

		expect(registry.pendingCount()).toBe(1);
		const result = await registry.drain(20);
		expect(result.timedOut).toBe(true);
		expect(result.unfinishedMessageIds).toEqual(["msg-dup"]);
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

		registry.trackTurn(
			"msg-fast",
			delay(1).then(() => {
				fastController.setDone();
			}),
		);
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
	it("waits for the status reaction to settle, not just the handler promise (#17749 review)", async () => {
		// The success path must mean "handler done AND reaction reconciled".
		// resolveFinished() fires inside the controller's serialised chain, so
		// it lands strictly after the handler promise — a fast turn could
		// otherwise settle the drain while its reaction was still showing
		// in-progress, and stop() would destroy the client on top of it. That
		// is the exact state this module exists to prevent, reached through
		// the success path rather than the timeout. Caught in review by
		// krutftw on the first head.
		const registry = createTurnDrainRegistry();
		let reactionSettled = false;
		let finishReaction: () => void = () => undefined;
		const controller = {
			whenFinished: new Promise<void>((resolve) => {
				finishReaction = () => {
					reactionSettled = true;
					resolve();
				};
			}),
			abandon: vi.fn(),
		} as unknown as StatusReactionController;

		registry.trackTurn("msg-race", Promise.resolve());
		registry.trackStatusReaction("msg-race", controller);

		let drainResolved = false;
		const drained = registry.drain(60_000).then((result) => {
			drainResolved = true;
			return result;
		});

		// Let every already-resolved promise flush. The handler is done; the
		// reaction is not. The drain must still be waiting.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(reactionSettled).toBe(false);
		expect(drainResolved).toBe(false);

		finishReaction();
		const result = await drained;
		expect(result.abandonedMessageIds).toEqual([]);
		expect(controller.abandon).not.toHaveBeenCalled();
	});
	it("abandons a reaction still mid-transition even after its handler untracked the entry (#17749 review)", async () => {
		// The handler's `finally` removes the entry as soon as the handler
		// settles, so a turn whose reaction is still mid-chain at the bound is
		// already gone from the map. Gating abandonment on map membership
		// therefore skipped exactly the case that needs reconciling: the
		// reaction stayed stranded in-progress AND the drain reported the
		// success path. Requested by @wtfsayo; fails against the previous
		// implementation, which returned no abandoned ids here.
		const registry = createTurnDrainRegistry();
		const controller = makeController();

		// Handler resolves immediately; the reaction never reaches a terminal
		// state on its own.
		registry.trackTurn("msg-stranded", Promise.resolve());
		registry.trackStatusReaction("msg-stranded", controller);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const result = await registry.drain(30);

		expect(result.abandonedMessageIds).toEqual(["msg-stranded"]);
		expect(controller.abandon).toHaveBeenCalledTimes(1);
	});
});
