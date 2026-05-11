import { describe, expect, it } from "vitest";
import {
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
				await new Promise<void>((_resolve, reject) => {
					signalB.addEventListener("abort", () => {
						bAborted = true;
						reject(new TurnAbortedError("b-cancel"));
					});
				});
				return "never";
			});

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
