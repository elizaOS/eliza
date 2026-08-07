/**
 * Unit coverage for `RoomHandlerQueue`: per-room serialization, cross-room
 * concurrency, cancellable leases, queue-depth accounting (`pendingFor`),
 * drain (`quiesce` / `quiesceAll`), empty-queue garbage collection, and
 * lifecycle events. Exercises the real queue with real timers; no model or
 * runtime.
 */
import { describe, expect, it } from "vitest";
import {
	RoomHandlerQueue,
	RoomHandlerQueueAbortedError,
	RoomHandlerQueueClosedError,
	RoomHandlerQueueGlobalSaturatedError,
	RoomHandlerQueueSaturatedError,
	type RoomQueueEvent,
} from "../room-handler-queue";

const ROOM_A = "00000000-0000-0000-0000-00000000000a";
const ROOM_B = "00000000-0000-0000-0000-00000000000b";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RoomHandlerQueue", () => {
	describe("runWith basics", () => {
		it("resolves with fn result", async () => {
			const queue = new RoomHandlerQueue();
			const result = await queue.runWith(ROOM_A, async () => 7);
			expect(result).toBe(7);
		});

		it("rethrows when fn rejects", async () => {
			const queue = new RoomHandlerQueue();
			await expect(
				queue.runWith(ROOM_A, async () => {
					throw new Error("fn-rejected");
				}),
			).rejects.toThrow("fn-rejected");
		});
	});

	describe("serialization within a room", () => {
		it("two enqueues on same roomId run sequentially", async () => {
			const queue = new RoomHandlerQueue();
			const trace: string[] = [];
			let firstStartedAt = 0;
			let firstEndedAt = 0;
			let secondStartedAt = 0;

			const first = queue.runWith(ROOM_A, async () => {
				firstStartedAt = Date.now();
				trace.push("start-1");
				await sleep(30);
				trace.push("end-1");
				firstEndedAt = Date.now();
			});
			const second = queue.runWith(ROOM_A, async () => {
				secondStartedAt = Date.now();
				trace.push("start-2");
				await sleep(5);
				trace.push("end-2");
			});

			await Promise.all([first, second]);

			expect(trace).toEqual(["start-1", "end-1", "start-2", "end-2"]);
			// Second handler must start AT OR AFTER the first one ended.
			expect(secondStartedAt).toBeGreaterThanOrEqual(firstEndedAt - 1);
			expect(secondStartedAt - firstStartedAt).toBeGreaterThanOrEqual(20);
		});

		it("failure in one fn does not block subsequent fns on the same room", async () => {
			const queue = new RoomHandlerQueue();
			const trace: string[] = [];

			const first = queue.runWith(ROOM_A, async () => {
				trace.push("first-running");
				throw new Error("first-fail");
			});
			const second = queue.runWith(ROOM_A, async () => {
				trace.push("second-running");
				return "second-ok";
			});

			await expect(first).rejects.toThrow("first-fail");
			await expect(second).resolves.toBe("second-ok");
			expect(trace).toEqual(["first-running", "second-running"]);
		});
	});

	describe("explicit room leases", () => {
		it("accepts only the exact live lease for its owning room", async () => {
			const queue = new RoomHandlerQueue();
			const lease = await queue.acquire(ROOM_A);

			expect(queue.ownsLease(ROOM_A, lease)).toBe(true);
			expect(queue.ownsLease(ROOM_B, lease)).toBe(false);
			expect(queue.ownsLease(ROOM_A, { release: async () => undefined })).toBe(
				false,
			);

			await lease.release();
			expect(queue.ownsLease(ROOM_A, lease)).toBe(false);
		});

		it("holds one room until release while unrelated rooms remain available", async () => {
			const queue = new RoomHandlerQueue();
			const first = await queue.acquire(ROOM_A);
			let secondGranted = false;
			const second = queue.acquire(ROOM_A).then((lease) => {
				secondGranted = true;
				return lease;
			});

			const otherRoom = await queue.acquire(ROOM_B);
			await otherRoom.release();
			await Promise.resolve();
			expect(secondGranted).toBe(false);

			await first.release();
			const secondLease = await second;
			expect(secondGranted).toBe(true);
			await secondLease.release();
		});

		it("removes a cancelled waiter without releasing an already granted lease", async () => {
			const queue = new RoomHandlerQueue();
			const activeController = new AbortController();
			const first = await queue.acquire(ROOM_A, activeController.signal);
			const waitingController = new AbortController();
			const cancelled = queue.acquire(ROOM_A, waitingController.signal);
			let thirdGranted = false;
			const third = queue.acquire(ROOM_A).then((lease) => {
				thirdGranted = true;
				return lease;
			});

			activeController.abort(new Error("transport ended after acquisition"));
			waitingController.abort(new Error("transport ended while queued"));
			await expect(cancelled).rejects.toBeInstanceOf(
				RoomHandlerQueueAbortedError,
			);
			await Promise.resolve();
			expect(thirdGranted).toBe(false);
			expect(queue.pendingFor(ROOM_A)).toBe(2);

			await first.release();
			const thirdLease = await third;
			expect(thirdGranted).toBe(true);
			await thirdLease.release();
			expect(queue.pendingFor(ROOM_A)).toBe(0);
		});

		it("rejects a saturated room promptly, preserves other rooms, and recovers after drain", async () => {
			const queue = new RoomHandlerQueue({ maxPendingPerRoom: 2 });
			const first = await queue.acquire(ROOM_A);
			const second = queue.acquire(ROOM_A);
			await Promise.resolve();
			expect(queue.pendingFor(ROOM_A)).toBe(2);

			await expect(queue.acquire(ROOM_A)).rejects.toMatchObject({
				name: "RoomHandlerQueueSaturatedError",
				code: "ROOM_HANDLER_QUEUE_SATURATED",
				roomId: ROOM_A,
				maxPendingPerRoom: 2,
				pendingCount: 2,
			});
			await expect(queue.acquire(ROOM_A)).rejects.toBeInstanceOf(
				RoomHandlerQueueSaturatedError,
			);

			const otherRoom = await queue.acquire(ROOM_B);
			await otherRoom.release();
			await first.release();
			const secondLease = await second;
			await secondLease.release();
			expect(queue.pendingFor(ROOM_A)).toBe(0);

			const recovered = await queue.acquire(ROOM_A);
			await recovered.release();
			expect(queue.pendingFor(ROOM_A)).toBe(0);
		});

		it("bounds total admissions and active room cardinality without losing recovery", async () => {
			const pendingBound = new RoomHandlerQueue({
				maxPendingPerRoom: 4,
				maxPendingTotal: 2,
				maxActiveRooms: 4,
			});
			const a = await pendingBound.acquire(ROOM_A);
			const b = await pendingBound.acquire(ROOM_B);
			await expect(
				pendingBound.acquire("00000000-0000-0000-0000-00000000000c"),
			).rejects.toMatchObject({
				code: "ROOM_HANDLER_QUEUE_GLOBAL_SATURATED",
				limitKind: "pending",
			});
			await a.release();
			const recovered = await pendingBound.acquire(
				"00000000-0000-0000-0000-00000000000c",
			);
			await recovered.release();
			await b.release();

			const roomBound = new RoomHandlerQueue({
				maxPendingPerRoom: 4,
				maxPendingTotal: 4,
				maxActiveRooms: 1,
			});
			const onlyRoom = await roomBound.acquire(ROOM_A);
			await expect(roomBound.acquire(ROOM_B)).rejects.toBeInstanceOf(
				RoomHandlerQueueGlobalSaturatedError,
			);
			await onlyRoom.release();
			const nextRoom = await roomBound.acquire(ROOM_B);
			await nextRoom.release();
		});

		it("freezes new admission while already-admitted work drains", async () => {
			const queue = new RoomHandlerQueue();
			const active = await queue.acquire(ROOM_A);
			let queuedGranted = false;
			const queued = queue.acquire(ROOM_A).then((lease) => {
				queuedGranted = true;
				return lease;
			});
			queue.closeAdmissions("runtime-swap");
			expect(queue.isAcceptingAdmissions()).toBe(false);
			await expect(queue.acquire(ROOM_B)).rejects.toBeInstanceOf(
				RoomHandlerQueueClosedError,
			);
			expect(queuedGranted).toBe(false);
			await active.release();
			const queuedLease = await queued;
			expect(queuedGranted).toBe(true);
			await queuedLease.release();
			await queue.quiesceAll();
			expect(queue.pendingTotal()).toBe(0);
		});

		it("uses explicit capabilities without deadlocking when async context is unavailable", async () => {
			const queue = new RoomHandlerQueue({ asyncContext: "explicit" });
			await expect(
				queue.runWith(ROOM_A, async () => "top-level-ok"),
			).resolves.toBe("top-level-ok");
			expect(queue.pendingFor(ROOM_A)).toBe(0);

			const lease = await queue.withLease(ROOM_A, async (ownedLease) => {
				expect(queue.ownsLease(ROOM_A, ownedLease)).toBe(true);
				const nested = await queue.runInLease(ROOM_A, ownedLease, () =>
					queue.runInLease(ROOM_A, ownedLease, async () => "nested-ok"),
				);
				expect(nested).toBe("nested-ok");
				await expect(
					queue.withLease(ROOM_A, async () => "reused", {
						lease: ownedLease,
					}),
				).resolves.toBe("reused");
				return ownedLease;
			});
			expect(queue.ownsLease(ROOM_A, lease)).toBe(false);
			await expect(
				queue.withLeases([ROOM_B, ROOM_A], async (leases) => {
					expect(leases.size).toBe(2);
					expect(queue.ownsLease(ROOM_A, leases.get(ROOM_A))).toBe(true);
					expect(queue.ownsLease(ROOM_B, leases.get(ROOM_B))).toBe(true);
					return "multi-room-ok";
				}),
			).resolves.toBe("multi-room-ok");

			const explicitLease = await queue.acquire(ROOM_A);
			const nested = await queue.runInLease(ROOM_A, explicitLease, () =>
				queue.runInLease(ROOM_A, explicitLease, async () => "nested-ok"),
			);
			expect(nested).toBe("nested-ok");
			expect(() =>
				queue.runInLease(ROOM_B, explicitLease, () => "wrong-room"),
			).toThrowError(
				expect.objectContaining({
					code: "ROOM_HANDLER_CROSS_ROOM_REENTRY",
				}),
			);
			await expect(
				queue.withLease(ROOM_B, async () => "widened", {
					lease: explicitLease,
				}),
			).rejects.toMatchObject({ code: "ROOM_HANDLER_CROSS_ROOM_REENTRY" });

			await explicitLease.release();
			expect(queue.pendingTotal()).toBe(0);
		});
	});

	describe("parallel across rooms", () => {
		it("two enqueues on different roomIds run concurrently", async () => {
			const queue = new RoomHandlerQueue();
			let aStartedAt = 0;
			let bStartedAt = 0;

			const a = queue.runWith(ROOM_A, async () => {
				aStartedAt = Date.now();
				await sleep(30);
				return "a-done";
			});
			const b = queue.runWith(ROOM_B, async () => {
				bStartedAt = Date.now();
				await sleep(30);
				return "b-done";
			});

			const [aRes, bRes] = await Promise.all([a, b]);
			expect(aRes).toBe("a-done");
			expect(bRes).toBe("b-done");

			// Both should have started effectively simultaneously
			// (within a few ms of each other).
			expect(Math.abs(aStartedAt - bStartedAt)).toBeLessThan(15);
		});
	});

	describe("pendingFor", () => {
		it("reflects queue depth including the active handler", async () => {
			const queue = new RoomHandlerQueue();
			let release: (() => void) | undefined;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});

			const first = queue.runWith(ROOM_A, async () => {
				await blocked;
			});
			const second = queue.runWith(ROOM_A, async () => undefined);
			const third = queue.runWith(ROOM_A, async () => undefined);

			// Give the first time to become active.
			await sleep(2);
			expect(queue.pendingFor(ROOM_A)).toBe(3);

			release?.();
			await Promise.all([first, second, third]);

			expect(queue.pendingFor(ROOM_A)).toBe(0);
		});

		it("returns 0 for unknown rooms", () => {
			const queue = new RoomHandlerQueue();
			expect(queue.pendingFor("unknown-room")).toBe(0);
		});
	});

	describe("quiesce", () => {
		it("quiesce(roomId) waits for active + queued work to drain", async () => {
			const queue = new RoomHandlerQueue();
			const order: string[] = [];

			queue.runWith(ROOM_A, async () => {
				await sleep(15);
				order.push("first-done");
			});
			queue.runWith(ROOM_A, async () => {
				await sleep(15);
				order.push("second-done");
			});

			await queue.quiesce(ROOM_A);
			order.push("after-quiesce");

			expect(order).toEqual(["first-done", "second-done", "after-quiesce"]);
			expect(queue.pendingFor(ROOM_A)).toBe(0);
		});

		it("quiesce on unknown room returns immediately", async () => {
			const queue = new RoomHandlerQueue();
			const start = Date.now();
			await queue.quiesce("unknown-room");
			expect(Date.now() - start).toBeLessThan(20);
		});

		it("quiesceAll waits for all rooms", async () => {
			const queue = new RoomHandlerQueue();
			const done: string[] = [];

			queue.runWith(ROOM_A, async () => {
				await sleep(15);
				done.push("a-done");
			});
			queue.runWith(ROOM_B, async () => {
				await sleep(25);
				done.push("b-done");
			});

			await queue.quiesceAll();
			expect(done.sort()).toEqual(["a-done", "b-done"]);
			expect(queue.pendingFor(ROOM_A)).toBe(0);
			expect(queue.pendingFor(ROOM_B)).toBe(0);
		});
	});

	describe("garbage collection", () => {
		it("empty queue is removed after drain (pendingFor returns 0)", async () => {
			const queue = new RoomHandlerQueue();
			await queue.runWith(ROOM_A, async () => 1);
			// Allow the finally block in runWith to do its GC pass.
			await sleep(1);
			expect(queue.pendingFor(ROOM_A)).toBe(0);
		});
	});

	describe("onEvent", () => {
		it("emits enqueued/completed on success", async () => {
			const queue = new RoomHandlerQueue();
			const events: RoomQueueEvent[] = [];
			queue.onEvent((e) => events.push(e));
			await queue.runWith(ROOM_A, async () => "ok");
			expect(events.map((e) => e.type)).toEqual(["enqueued", "completed"]);
			expect(events[0]).toMatchObject({ type: "enqueued", roomId: ROOM_A });
			expect(events[1]).toMatchObject({ type: "completed", roomId: ROOM_A });
		});

		it("emits enqueued/errored on failure", async () => {
			const queue = new RoomHandlerQueue();
			const events: RoomQueueEvent[] = [];
			queue.onEvent((e) => events.push(e));
			await expect(
				queue.runWith(ROOM_A, async () => {
					throw new Error("bad");
				}),
			).rejects.toThrow("bad");
			expect(events.map((e) => e.type)).toEqual(["enqueued", "errored"]);
			const errored = events[1];
			if (errored.type === "errored") {
				expect(errored.error).toBe("bad");
			}
		});

		it("unsubscribes via returned disposer", async () => {
			const queue = new RoomHandlerQueue();
			const events: RoomQueueEvent[] = [];
			const unsub = queue.onEvent((e) => events.push(e));
			unsub();
			await queue.runWith(ROOM_A, async () => "ok");
			expect(events).toHaveLength(0);
		});

		it("reports listener errors without blocking queue progress", async () => {
			const reported: Array<{ error: unknown; event: RoomQueueEvent }> = [];
			const observed: RoomQueueEvent[] = [];
			const queue = new RoomHandlerQueue({
				onListenerError: (error, event) => reported.push({ error, event }),
			});
			queue.onEvent(() => {
				throw new Error("listener-boom");
			});
			queue.onEvent((event) => observed.push(event));
			await expect(queue.runWith(ROOM_A, async () => "ok")).resolves.toBe("ok");
			expect(observed.map((event) => event.type)).toEqual([
				"enqueued",
				"completed",
			]);
			expect(reported).toHaveLength(2);
			expect(reported[0]?.error).toMatchObject({ message: "listener-boom" });
			expect(reported.map(({ event }) => event.type)).toEqual([
				"enqueued",
				"completed",
			]);
		});
	});
});
