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
		await siblingStarted.promise;

		const caller = registry.runWith("room-1", async (signal) => {
			const aborted = registry.abortTurn("room-1", "user_requested_abort");
			release.resolve();
			return { aborted, selfAborted: signal.aborted };
		});

		await expect(sibling).rejects.toBeInstanceOf(TurnAbortedError);
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
		await Promise.all(started.map((g) => g.promise));

		expect(registry.abortTurn("room-1", "http-stop")).toBe(true);
		for (const turn of turns) {
			await expect(turn).rejects.toBeInstanceOf(TurnAbortedError);
		}
		expect(registry.hasActiveTurn("room-1")).toBe(false);
	});
});
