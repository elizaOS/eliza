/**
 * Exercises real turn registration, cancellation isolation, lifecycle events,
 * and cleanup. Explicit completion gates keep concurrent turns pending without
 * sleeps, polling, or a mocked registry.
 */
import { describe, expect, it } from "vitest";
import {
	TurnAbortedError,
	TurnControllerRegistry,
	type TurnEvent,
} from "./turn-controller";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("TurnControllerRegistry", () => {
	it("an in-turn abort spares the calling turn and aborts its sibling", async () => {
		const registry = new TurnControllerRegistry();
		const siblingStarted = deferred();
		const release = deferred();

		const sibling = registry.runWith("room-1", async (signal) => {
			siblingStarted.resolve();
			await release.promise;
			if (signal.aborted) throw signal.reason;
			return "sibling-survived";
		});
		const siblingOutcome =
			expect(sibling).rejects.toBeInstanceOf(TurnAbortedError);
		await siblingStarted.promise;

		const caller = registry.runWith("room-1", async (signal) => {
			expect(registry.hasAbortableTurn("room-1")).toBe(true);
			expect(registry.hasAbortableTurn("another-room")).toBe(false);
			const aborted = registry.abortTurn("room-1", "user_requested_abort");
			expect(registry.hasAbortableTurn("room-1")).toBe(false);
			release.resolve();
			return { aborted, selfAborted: signal.aborted };
		});

		await siblingOutcome;
		await expect(caller).resolves.toEqual({
			aborted: true,
			selfAborted: false,
		});
		expect(registry.hasActiveTurn("room-1")).toBe(false);
	});

	it("an in-turn abort with no siblings aborts nothing", async () => {
		const registry = new TurnControllerRegistry();
		const result = await registry.runWith("room-1", async (signal) => {
			expect(registry.hasActiveTurn("room-1")).toBe(true);
			expect(registry.hasAbortableTurn("room-1")).toBe(false);
			return {
				aborted: registry.abortTurn("room-1", "user_requested_abort"),
				selfAborted: signal.aborted,
			};
		});
		expect(result).toEqual({ aborted: false, selfAborted: false });
	});

	it("an out-of-band abort kills every turn in the room", async () => {
		const registry = new TurnControllerRegistry();
		const started = [deferred(), deferred()];
		const turns = started.map((gate, i) =>
			registry.runWith("room-1", async (signal) => {
				gate.resolve();
				await new Promise<void>((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
				return i;
			}),
		);
		const outcomes = turns.map((turn) =>
			expect(turn).rejects.toBeInstanceOf(TurnAbortedError),
		);
		await Promise.all(started.map((g) => g.promise));

		expect(registry.hasAbortableTurn("room-1")).toBe(true);
		expect(registry.abortTurn("room-1", "http-stop")).toBe(true);
		expect(registry.hasAbortableTurn("room-1")).toBe(false);
		await Promise.all(outcomes);
		expect(registry.hasActiveTurn("room-1")).toBe(false);
	});
	it("registers its signal, returns the result, cleans up, and supports unsubscribing", async () => {
		const registry = new TurnControllerRegistry();
		const events: TurnEvent[] = [];
		const unsubscribe = registry.onEvent((event) => events.push(event));
		expect(registry.hasActiveTurn("room-1")).toBe(false);
		expect(registry.signalFor("room-1")).toBeNull();
		await expect(
			registry.runWith("room-1", async (signal) => {
				expect(registry.hasActiveTurn("room-1")).toBe(true);
				expect(registry.signalFor("room-1")).toBe(signal);
				return 42;
			}),
		).resolves.toBe(42);
		expect(registry.hasActiveTurn("room-1")).toBe(false);
		expect(registry.signalFor("room-1")).toBeNull();
		expect(events).toMatchObject([
			{ type: "started", roomId: "room-1" },
			{ type: "completed", roomId: "room-1" },
		]);
		unsubscribe();
		await registry.runWith("room-1", async () => undefined);
		expect(events).toHaveLength(2);
	});

	it.each([false, true])(
		"preserves operation errors and cleans up (deferred=%s)",
		async (defer) => {
			const registry = new TurnControllerRegistry();
			const events: TurnEvent[] = [];
			const failure = new Error("operation failed");
			registry.onEvent((event) => events.push(event));
			await expect(
				registry.runWith("room-1", async () => {
					expect(registry.hasActiveTurn("room-1")).toBe(true);
					if (defer) await Promise.resolve();
					throw failure;
				}),
			).rejects.toBe(failure);
			expect(registry.hasActiveTurn("room-1")).toBe(false);
			expect(registry.signalFor("room-1")).toBeNull();
			expect(events).toMatchObject([
				{ type: "started", roomId: "room-1" },
				{ type: "errored", roomId: "room-1", error: failure.message },
			]);
		},
	);

	it("aborts only the selected room once and emits cleanup with the original reason", async () => {
		const registry = new TurnControllerRegistry();
		const release = deferred();
		const events: TurnEvent[] = [];
		registry.onEvent((event) => events.push(event));
		const cancelled = registry.runWith("room-1", async (signal) => {
			await release.promise;
			signal.throwIfAborted();
		});
		const survivor = registry.runWith("room-2", async (signal) => {
			await release.promise;
			signal.throwIfAborted();
			return "complete";
		});
		const cancelledOutcome = expect(cancelled).rejects.toMatchObject({
			code: "TURN_ABORTED",
			reason: "user-cancel",
			message: "Turn aborted: user-cancel",
		});
		const firstSignal = registry.signalFor("room-1");
		expect(firstSignal?.aborted).toBe(false);
		expect(registry.abortTurn("missing-room", "no-turn")).toBe(false);
		expect(registry.abortTurn("room-1", "user-cancel")).toBe(true);
		expect(firstSignal?.aborted).toBe(true);
		expect(registry.abortTurn("room-1", "second-cancel")).toBe(false);
		expect(registry.signalFor("room-2")?.aborted).toBe(false);
		release.resolve();
		await cancelledOutcome;
		await expect(survivor).resolves.toBe("complete");
		for (const room of ["room-1", "room-2"]) {
			expect(registry.hasActiveTurn(room)).toBe(false);
			expect(registry.signalFor(room)).toBeNull();
		}
		expect(events.filter((event) => event.roomId === "room-1")).toMatchObject([
			{ type: "started" },
			{ type: "aborted", reason: "user-cancel" },
			{ type: "aborted-cleanup", reason: "user-cancel" },
		]);
	});

	it("isolates listener failures from the operation and other subscribers", async () => {
		const registry = new TurnControllerRegistry();
		const events: TurnEvent[] = [];
		registry.onEvent(() => {
			throw new Error("listener failed");
		});
		registry.onEvent((event) => events.push(event));
		await expect(
			registry.runWith("room-1", async () => "complete"),
		).resolves.toBe("complete");
		expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
	});
});
