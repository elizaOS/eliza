/**
 * Unit tests for TurnControllerRegistry: per-room turn registration and
 * cleanup, abort signalling, lifecycle events, and cross-room isolation. Fully
 * in-process and deterministic (real timers, no model or DB).
 */
import { describe, expect, it } from "vitest";
import {
	DuplicateTurnRequestAdmissionError,
	TurnAbortedError,
	TurnControllerRegistry,
	type TurnEvent,
} from "../turn-controller";

const ROOM_A = "00000000-0000-0000-0000-00000000000a";
const ROOM_B = "00000000-0000-0000-0000-00000000000b";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TurnControllerRegistry", () => {
	describe("runWith", () => {
		it("resolves with fn result", async () => {
			const registry = new TurnControllerRegistry();
			const result = await registry.runWith(ROOM_A, async () => 42);
			expect(result).toBe(42);
		});

		it("rethrows sync errors thrown by fn", async () => {
			const registry = new TurnControllerRegistry();
			await expect(
				registry.runWith(ROOM_A, async () => {
					throw new Error("sync-boom");
				}),
			).rejects.toThrow("sync-boom");
		});

		it("rethrows async rejections", async () => {
			const registry = new TurnControllerRegistry();
			await expect(
				registry.runWith(ROOM_A, async () => {
					await Promise.resolve();
					return Promise.reject(new Error("async-boom"));
				}),
			).rejects.toThrow("async-boom");
		});

		it("registers turn for duration and cleans up on success", async () => {
			const registry = new TurnControllerRegistry();
			let activeDuringFn = false;
			await registry.runWith(ROOM_A, async () => {
				activeDuringFn = registry.hasActiveTurn(ROOM_A);
				return "ok";
			});
			expect(activeDuringFn).toBe(true);
			expect(registry.hasActiveTurn(ROOM_A)).toBe(false);
		});

		it("cleans up registration when fn throws", async () => {
			const registry = new TurnControllerRegistry();
			await expect(
				registry.runWith(ROOM_A, async () => {
					expect(registry.hasActiveTurn(ROOM_A)).toBe(true);
					throw new Error("nope");
				}),
			).rejects.toThrow("nope");
			expect(registry.hasActiveTurn(ROOM_A)).toBe(false);
		});

		it("cleans up registration after abort", async () => {
			const registry = new TurnControllerRegistry();
			const turnPromise = registry.runWith(ROOM_A, async (signal) => {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new TurnAbortedError("test-abort")),
					);
				});
				return "never";
			});
			// Let the registry record the turn.
			await sleep(2);
			registry.abortTurn(ROOM_A, "test-abort");
			await expect(turnPromise).rejects.toBeInstanceOf(TurnAbortedError);
			expect(registry.hasActiveTurn(ROOM_A)).toBe(false);
		});

		it("exposes settlement for exactly the active turn", async () => {
			const registry = new TurnControllerRegistry();
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const turn = registry.runWith(ROOM_A, async () => {
				await gate;
				return "settled";
			});
			const settlement = registry.settlementFor(ROOM_A);
			expect(settlement).not.toBeNull();
			let observed = false;
			void settlement?.then(() => {
				observed = true;
			});
			await Promise.resolve();
			expect(observed).toBe(false);

			release?.();
			await expect(turn).resolves.toBe("settled");
			await settlement;
			expect(observed).toBe(true);
			expect(registry.settlementFor(ROOM_A)).toBeNull();
		});
	});

	describe("exact request admission", () => {
		it("consumes a pre-abort tombstone as an already-aborted signal", async () => {
			const registry = new TurnControllerRegistry();
			const preAbort = registry.abortRequestAdmission(
				ROOM_A,
				"message-before-register",
				"voice-interrupt",
			);
			expect(preAbort).toMatchObject({
				requestAborted: false,
				requestObserved: false,
				requestArmed: true,
				requestArmRejected: false,
				requestIngressState: "pending",
				requestIngressFailure: null,
			});
			let settled = false;
			void preAbort.settlement.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);

			const admission = registry.registerRequestAdmission(
				ROOM_A,
				"message-before-register",
			);
			expect(admission.signal.aborted).toBe(true);
			expect(admission.signal.reason).toMatchObject({
				code: "TURN_ABORTED",
				reason: "voice-interrupt",
			});
			expect(
				registry.hasRequestAdmission(ROOM_A, "message-before-register"),
			).toBe(true);
			expect(admission.markIngressCommitted()).toBe(true);
			expect(preAbort.requestIngressState).toBe("committed");
			admission.finish();
			admission.finish();
			await admission.settlement;
			expect(
				registry.hasRequestAdmission(ROOM_A, "message-before-register"),
			).toBe(false);
		});

		it("aborts and exposes settlement for exactly one active request", async () => {
			const registry = new TurnControllerRegistry();
			const admission = registry.registerRequestAdmission(ROOM_A, "active-a");
			const result = registry.abortRequestAdmission(
				ROOM_A,
				"active-a",
				"replace",
			);
			expect(result).toMatchObject({
				requestAborted: true,
				requestObserved: true,
				requestArmed: false,
				requestArmRejected: false,
				requestIngressState: "pending",
			});
			expect(admission.signal.aborted).toBe(true);
			let settled = false;
			void result.settlement.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);

			admission.markIngressCommitted();
			admission.finish();
			await result.settlement;
			expect(settled).toBe(true);
			expect(result.requestIngressState).toBe("committed");
		});

		it("fails unfinished ingress and retains a bounded terminal receipt", async () => {
			const registry = new TurnControllerRegistry();
			const admission = registry.registerRequestAdmission(
				ROOM_A,
				"unfinished-ingress",
			);
			admission.finish();
			await admission.settlement;
			expect(admission.requestIngressState).toBe("failed");
			expect(admission.requestIngressFailure).toBe(
				"request_finished_before_ingress",
			);

			const receipt = registry.abortRequestAdmission(
				ROOM_A,
				"unfinished-ingress",
				"retry",
			);
			expect(receipt).toMatchObject({
				requestObserved: true,
				requestArmed: false,
				requestIngressState: "failed",
				requestIngressFailure: "request_finished_before_ingress",
			});
			await receipt.settlement;
		});

		it("isolates the same id across rooms and different ids within a room", () => {
			const registry = new TurnControllerRegistry();
			const target = registry.registerRequestAdmission(ROOM_A, "same-id");
			const sameRoomOtherId = registry.registerRequestAdmission(
				ROOM_A,
				"other-id",
			);
			const otherRoomSameId = registry.registerRequestAdmission(
				ROOM_B,
				"same-id",
			);

			registry.abortRequestAdmission(ROOM_A, "same-id", "target-only");
			expect(target.signal.aborted).toBe(true);
			expect(sameRoomOtherId.signal.aborted).toBe(false);
			expect(otherRoomSameId.signal.aborted).toBe(false);
			target.finish();
			sameRoomOtherId.finish();
			otherRoomSameId.finish();
		});

		it("rejects active and recently settled duplicate request ids", () => {
			let now = 1_000;
			const registry = new TurnControllerRegistry({
				requestAdmissionNow: () => now,
				requestAbortTombstoneTtlMs: 50,
			});
			const admission = registry.registerRequestAdmission(ROOM_A, "duplicate");
			expect(() =>
				registry.registerRequestAdmission(ROOM_A, "duplicate"),
			).toThrow(DuplicateTurnRequestAdmissionError);
			admission.markIngressCommitted();
			admission.finish();
			expect(() =>
				registry.registerRequestAdmission(ROOM_A, "duplicate"),
			).toThrow(DuplicateTurnRequestAdmissionError);
			now += 51;
			const replacement = registry.registerRequestAdmission(
				ROOM_A,
				"duplicate",
			);
			expect(replacement.signal.aborted).toBe(false);
			replacement.finish();
		});

		it("a late old-id abort never affects a newer id in the same room", () => {
			const registry = new TurnControllerRegistry();
			const newer = registry.registerRequestAdmission(ROOM_A, "new-id");
			registry.abortRequestAdmission(ROOM_A, "old-id", "late-old-cancel");
			expect(newer.signal.aborted).toBe(false);

			const old = registry.registerRequestAdmission(ROOM_A, "old-id");
			expect(old.signal.aborted).toBe(true);
			expect(newer.signal.aborted).toBe(false);
			old.finish();
			newer.finish();
		});

		it("fails closed at tombstone capacity and expires pending barriers", async () => {
			let now = 1_000;
			const registry = new TurnControllerRegistry({
				requestAdmissionNow: () => now,
				requestAbortTombstoneCapacity: 2,
				requestAbortTombstoneTtlMs: 50,
			});
			const oldest = registry.abortRequestAdmission(
				ROOM_A,
				"oldest",
				"cancel-oldest",
			);
			const middle = registry.abortRequestAdmission(
				ROOM_A,
				"middle",
				"cancel-middle",
			);
			const rejected = registry.abortRequestAdmission(
				ROOM_A,
				"newest",
				"cancel-newest",
			);
			expect(rejected).toMatchObject({
				requestArmed: false,
				requestArmRejected: true,
				requestIngressState: "failed",
				requestIngressFailure: "abort_tombstone_capacity",
			});

			now += 51;
			registry.abortRequestAdmission(ROOM_B, "purge", "trigger-purge");
			await oldest.settlement;
			await middle.settlement;
			expect(oldest.requestIngressState).toBe("failed");
			expect(oldest.requestIngressFailure).toBe("abort_tombstone_expired");
		});
	});

	describe("abortTurn", () => {
		it("returns true and fires controller signal", async () => {
			const registry = new TurnControllerRegistry();
			let observedSignal: AbortSignal | undefined;
			const turnPromise = registry.runWith(ROOM_A, async (signal) => {
				observedSignal = signal;
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new TurnAbortedError("user-cancel")),
					);
				});
				return "never";
			});
			await sleep(2);
			const aborted = registry.abortTurn(ROOM_A, "user-cancel");
			expect(aborted).toBe(true);
			expect(observedSignal?.aborted).toBe(true);
			await expect(turnPromise).rejects.toBeInstanceOf(TurnAbortedError);
		});

		it("returns false when no active turn for the room", () => {
			const registry = new TurnControllerRegistry();
			expect(registry.abortTurn(ROOM_A, "no-turn")).toBe(false);
		});

		it("returns false on second abort call for the same turn", async () => {
			const registry = new TurnControllerRegistry();
			const turnPromise = registry.runWith(ROOM_A, async (signal) => {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new TurnAbortedError("first")),
					);
				});
				return "never";
			});
			await sleep(2);
			expect(registry.abortTurn(ROOM_A, "first")).toBe(true);
			// Second call should be a no-op since signal is already aborted.
			expect(registry.abortTurn(ROOM_A, "second")).toBe(false);
			await expect(turnPromise).rejects.toBeInstanceOf(TurnAbortedError);
		});
	});

	describe("hasActiveTurn / signalFor", () => {
		it("hasActiveTurn returns true during runWith, false outside", async () => {
			const registry = new TurnControllerRegistry();
			expect(registry.hasActiveTurn(ROOM_A)).toBe(false);
			let snapshot = false;
			await registry.runWith(ROOM_A, async () => {
				snapshot = registry.hasActiveTurn(ROOM_A);
			});
			expect(snapshot).toBe(true);
			expect(registry.hasActiveTurn(ROOM_A)).toBe(false);
		});

		it("signalFor returns signal during runWith, null otherwise", async () => {
			const registry = new TurnControllerRegistry();
			expect(registry.signalFor(ROOM_A)).toBeNull();
			let inner: AbortSignal | null = null;
			await registry.runWith(ROOM_A, async () => {
				inner = registry.signalFor(ROOM_A);
			});
			expect(inner).not.toBeNull();
			expect(inner instanceof AbortSignal).toBe(true);
			expect(registry.signalFor(ROOM_A)).toBeNull();
		});
	});

	describe("isolation between rooms", () => {
		it("two rooms run concurrently and abort on one does not affect the other", async () => {
			const registry = new TurnControllerRegistry();
			let resolveA: (() => void) | undefined;
			const aDone = new Promise<void>((resolve) => {
				resolveA = resolve;
			});
			let bAborted = false;

			const promiseA = registry.runWith(ROOM_A, async (signalA) => {
				await aDone;
				return signalA.aborted ? "aborted" : "complete";
			});
			const promiseB = registry.runWith(ROOM_B, async (signalB) => {
				// Poll the abort flag rather than rejecting from inside an abort
				// listener: bun's ``AbortController.abort`` surfaces listener
				// rejections back through the abort() call site, which fails the
				// surrounding test instead of just rejecting ``promiseB``.
				while (!signalB.aborted) {
					await sleep(1);
				}
				bAborted = true;
				throw new TurnAbortedError("b-cancel");
			});
			// Swallow the eventual rejection on a side handle so the runtime
			// doesn't flag it as unhandled before ``await expect(...).rejects``
			// observes it below.
			promiseB.catch(() => {});

			await sleep(2);
			expect(registry.hasActiveTurn(ROOM_A)).toBe(true);
			expect(registry.hasActiveTurn(ROOM_B)).toBe(true);

			const aborted = registry.abortTurn(ROOM_B, "b-cancel");
			expect(aborted).toBe(true);

			resolveA?.();

			await expect(promiseA).resolves.toBe("complete");
			await expect(promiseB).rejects.toBeInstanceOf(TurnAbortedError);
			expect(bAborted).toBe(true);
		});
	});

	describe("onEvent", () => {
		it("emits started then completed on happy path", async () => {
			const registry = new TurnControllerRegistry();
			const events: TurnEvent[] = [];
			registry.onEvent((e) => events.push(e));
			await registry.runWith(ROOM_A, async () => "ok");
			expect(events.map((e) => e.type)).toEqual(["started", "completed"]);
			expect(events[0]).toMatchObject({ type: "started", roomId: ROOM_A });
			expect(events[1]).toMatchObject({ type: "completed", roomId: ROOM_A });
		});

		it("emits errored on throw (non-abort path)", async () => {
			const registry = new TurnControllerRegistry();
			const events: TurnEvent[] = [];
			registry.onEvent((e) => events.push(e));
			await expect(
				registry.runWith(ROOM_A, async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(events.map((e) => e.type)).toEqual(["started", "errored"]);
			const errored = events[1];
			expect(errored.type).toBe("errored");
			if (errored.type === "errored") {
				expect(errored.error).toBe("boom");
			}
		});

		it("emits aborted then aborted-cleanup on abort path", async () => {
			const registry = new TurnControllerRegistry();
			const events: TurnEvent[] = [];
			registry.onEvent((e) => events.push(e));
			const turnPromise = registry.runWith(ROOM_A, async (signal) => {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new TurnAbortedError("user-cancel")),
					);
				});
				return "never";
			});
			await sleep(2);
			registry.abortTurn(ROOM_A, "user-cancel");
			await expect(turnPromise).rejects.toBeInstanceOf(TurnAbortedError);
			const types = events.map((e) => e.type);
			expect(types).toEqual(["started", "aborted", "aborted-cleanup"]);
			const cleanup = events[2];
			if (cleanup.type === "aborted-cleanup") {
				expect(cleanup.reason).toBe("user-cancel");
			}
		});

		it("unsubscribes via the returned disposer", async () => {
			const registry = new TurnControllerRegistry();
			const events: TurnEvent[] = [];
			const unsubscribe = registry.onEvent((e) => events.push(e));
			unsubscribe();
			await registry.runWith(ROOM_A, async () => "ok");
			expect(events).toHaveLength(0);
		});

		it("swallows listener errors so they do not affect runtime", async () => {
			const registry = new TurnControllerRegistry();
			registry.onEvent(() => {
				throw new Error("listener-boom");
			});
			const result = await registry.runWith(ROOM_A, async () => "still-works");
			expect(result).toBe("still-works");
		});
	});

	describe("TurnAbortedError", () => {
		it("carries .reason and .code", () => {
			const err = new TurnAbortedError("user-cancel");
			expect(err.reason).toBe("user-cancel");
			expect(err.code).toBe("TURN_ABORTED");
			expect(err.message).toBe("Turn aborted: user-cancel");
			expect(err).toBeInstanceOf(Error);
		});
	});
});
