/**
 * Deterministic unit coverage for TurnControllerRegistry's multi-turn room
 * tracking: an abort issued from inside a turn spares the calling turn and
 * kills its concurrent siblings, while out-of-band aborts kill everything.
 * Real registry, no mocks.
 */
import { describe, expect, it } from "vitest";
import { TurnAbortedError, TurnControllerRegistry } from "./turn-controller";

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
			const aborted = registry.abortTurn("room-1", "user_requested_abort");
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
		const result = await registry.runWith("room-1", async (signal) => ({
			aborted: registry.abortTurn("room-1", "user_requested_abort"),
			selfAborted: signal.aborted,
		}));
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

		expect(registry.abortTurn("room-1", "http-stop")).toBe(true);
		await Promise.all(outcomes);
	});

	it("an out-of-band abort kills an ACTIVE owner and its waiter simultaneously", async () => {
		// The positional heuristic this suite replaced ("abort only the last
		// entry") reported success while the FIRST turn — a live planner or
		// action mid-side-effect — kept running spend. Both turns here are
		// simultaneously active; the room-wide stop must reach both.
		const registry = new TurnControllerRegistry();
		const started = [deferred(), deferred()];
		const turns = [
			registry.runWith("room-1", async (signal) => {
				started[0].resolve();
				await hangUntilAborted(signal);
				return "owner";
			}),
			registry.runWith("room-1", async (signal) => {
				started[1].resolve();
				await hangUntilAborted(signal);
				return "waiter";
			}),
		];
		await Promise.all(started.map((g) => g.promise));

		expect(registry.abortTurn("room-1", "http-stop")).toBe(true);

		const outcomes = await Promise.allSettled(turns);
		expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
		for (const outcome of outcomes) {
			const cause = (outcome as PromiseRejectedResult).reason;
			expect(cause).toBeInstanceOf(TurnAbortedError);
			expect((cause as TurnAbortedError).reason).toBe("http-stop");
		}
	});

	it("an out-of-band abort reaches the OLDEST turn among 3+ concurrent turns", async () => {
		// A last-entry heuristic would strand the oldest registered turn; a
		// voice barge-in must not leave it running side effects or spend.
		const registry = new TurnControllerRegistry();
		const started = [deferred(), deferred(), deferred()];
		const turns = [0, 1, 2].map((i) =>
			registry.runWith("room-1", async (signal) => {
				started[i].resolve();
				await hangUntilAborted(signal);
				return i;
			}),
		);
		await Promise.all(started.map((g) => g.promise));

		expect(registry.abortTurn("room-1", "voice-barge-in")).toBe(true);

		const outcomes = await Promise.allSettled(turns);
		expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
		for (const outcome of outcomes) {
			expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
				TurnAbortedError,
			);
		}
	});

	it("an out-of-band abort after interleaved completions aborts every survivor", async () => {
		// Generations interleave: gen-1 completes before the stop, then two
		// gen-2 turns overlap when the stop arrives — both must be aborted
		// and the room must end empty.
		const registry = new TurnControllerRegistry();
		const earlyDone = deferred();
		const early = registry.runWith("room-1", async () => {
			earlyDone.resolve();
			return "early";
		});
		await earlyDone.promise;

		const lateStarted = [deferred(), deferred()];
		const late = [
			registry.runWith("room-1", async (signal) => {
				lateStarted[0].resolve();
				await hangUntilAborted(signal);
				return "late-a";
			}),
			registry.runWith("room-1", async (signal) => {
				lateStarted[1].resolve();
				await hangUntilAborted(signal);
				return "late-b";
			}),
		];
		await Promise.all(lateStarted.map((g) => g.promise));
		await expect(early).resolves.toBe("early");

		expect(registry.abortTurn("room-1", "http-stop")).toBe(true);

		const outcomes = await Promise.allSettled(late);
		expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
		expect(registry.hasActiveTurn("room-1")).toBe(false);
	});
});

/**
 * A turn body that stays pending until its signal fires, then rejects with
 * the abort reason — models how a real planner/provider step observes
 * cancellation without adding wall-clock timing to the suite.
 */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
	return new Promise<never>((_, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}
