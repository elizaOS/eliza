import { describe, expect, it } from "vitest";
import { RoomHandlerQueue, type RoomQueueEvent } from "../room-handler-queue";

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

		it("swallows listener errors", async () => {
			const queue = new RoomHandlerQueue();
			queue.onEvent(() => {
				throw new Error("listener-boom");
			});
			await expect(queue.runWith(ROOM_A, async () => "ok")).resolves.toBe("ok");
		});
	});
});
