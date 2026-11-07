/** Real lease/promise traces for quint/PostDeliveryTasks.qnt. */
import { setImmediate } from "node:timers";
import { describe, expect, it } from "vitest";
import { RoomHandlerQueue } from "../src/runtime/room-handler-queue";
import {
	drainPostDeliveryTasks,
	drainRoomPostDeliveryTasks,
	pendingPostDeliveryTaskCount,
	pendingRoomPostDeliveryTaskCount,
	postDeliveryTaskQuarantineReason,
	quarantinePostDeliveryTasks,
	roomDeliverySettlement,
	trackPostDeliveryTask,
	withRoomDeliverySettlement,
} from "../src/services/post-delivery-task-tracker";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(queue?: RoomHandlerQueue) {
	const errors: unknown[] = [];
	return {
		runtime: {
			agentId: "post-delivery-conformance",
			...(queue ? { roomHandlerQueue: queue } : {}),
			reportError: (_label: string, error: unknown) => errors.push(error),
		},
		errors,
	};
}

describe("PostDeliveryTasks source conformance", () => {
	it("requires an exact live room lease and preserves both indexes on refusal", async () => {
		const queue = new RoomHandlerQueue({ asyncContext: "explicit" });
		const { runtime } = fixture(queue);
		const lease = await queue.acquire("a");
		const otherLease = await queue.acquire("b");
		try {
			expect(() =>
				trackPostDeliveryTask(runtime, "unscoped", async () => {}),
			).toThrowError(
				expect.objectContaining({
					code: "POST_DELIVERY_ROOM_OWNERSHIP_REQUIRED",
				}),
			);
			expect(() =>
				trackPostDeliveryTask(runtime, "partial", async () => {}, {
					kind: "room-state",
					roomId: "a",
				}),
			).toThrowError(
				expect.objectContaining({
					code: "POST_DELIVERY_ROOM_OWNERSHIP_INVALID",
				}),
			);
			expect(() =>
				trackPostDeliveryTask(runtime, "wrong-room", async () => {}, {
					kind: "room-state",
					roomId: "a",
					roomHandlerLease: otherLease,
				}),
			).toThrowError(
				expect.objectContaining({ code: "POST_DELIVERY_ROOM_LEASE_MISMATCH" }),
			);
			expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
			const task = trackPostDeliveryTask(runtime, "exact", async () => {}, {
				kind: "room-state",
				roomId: "a",
				roomHandlerLease: lease,
			});
			expect(pendingRoomPostDeliveryTaskCount(runtime, "a")).toBe(1);
			await task;
			expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
			await lease.release();
			expect(() =>
				trackPostDeliveryTask(runtime, "released", async () => {}, {
					kind: "room-state",
					roomId: "a",
					roomHandlerLease: lease,
				}),
			).toThrowError(
				expect.objectContaining({ code: "POST_DELIVERY_ROOM_LEASE_MISMATCH" }),
			);
			await trackPostDeliveryTask(runtime, "diagnostic", async () => {}, {
				kind: "diagnostic",
			});
			expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
		} finally {
			await lease.release();
			await otherLease.release();
		}
	});

	it("holds the real room owner until delivery and room-state work settle", async () => {
		const queue = new RoomHandlerQueue();
		const { runtime } = fixture(queue);
		const delivery = deferred<string>();
		const work = deferred<void>();
		const entered = deferred<void>();
		const events: string[] = [];
		const flow = queue.withLease("a", (lease) =>
			withRoomDeliverySettlement(runtime, "a", lease, async () => {
				trackPostDeliveryTask(runtime, "state", async () => {
					entered.resolve();
					expect(await roomDeliverySettlement(runtime, "a")).toBe(true);
					events.push("delivered");
					await work.promise;
					events.push("state-settled");
				});
				expect(() =>
					roomDeliverySettlement(runtime, "a", { release: async () => {} }),
				).toThrowError(
					expect.objectContaining({
						code: "POST_DELIVERY_SETTLEMENT_LEASE_MISMATCH",
					}),
				);
				await expect(
					withRoomDeliverySettlement(runtime, "a", lease, async () => {}),
				).rejects.toMatchObject({
					code: "POST_DELIVERY_SETTLEMENT_ALREADY_ACTIVE",
				});
				return delivery.promise;
			}),
		);
		await entered.promise;
		const next = queue.withLease("a", async () => events.push("next-owner"));
		delivery.resolve("persisted");
		await flush();
		expect(events).toEqual(["delivered"]);
		expect(pendingRoomPostDeliveryTaskCount(runtime, "a")).toBe(1);
		work.resolve();
		expect(await flow).toBe("persisted");
		await next;
		expect(events).toEqual(["delivered", "state-settled", "next-owner"]);
		expect(await roomDeliverySettlement(runtime, "a")).toBe(true);
	});

	it("settles failed delivery as false before removing its boundary", async () => {
		const queue = new RoomHandlerQueue();
		const { runtime } = fixture(queue);
		const delivery = deferred<void>();
		const entered = deferred<void>();
		const observed: boolean[] = [];
		const failure = new Error("connector persistence failed");
		const flow = queue.withLease("a", (lease) =>
			withRoomDeliverySettlement(runtime, "a", lease, async () => {
				trackPostDeliveryTask(runtime, "state", async () => {
					entered.resolve();
					observed.push(await roomDeliverySettlement(runtime, "a"));
				});
				return delivery.promise;
			}),
		);
		const outcome = flow.catch((error: unknown) => error);
		await entered.promise;
		delivery.reject(failure);
		expect(await outcome).toBe(failure);
		expect(observed).toEqual([false]);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
		expect(await roomDeliverySettlement(runtime, "a")).toBe(true);
	});

	it("preserves a captured failed settlement after quarantine removes the boundary", async () => {
		const queue = new RoomHandlerQueue();
		const { runtime } = fixture(queue);
		const delivery = deferred<void>();
		const entered = deferred<void>();
		const read = deferred<void>();
		let task: Promise<void> | undefined;
		let observed: boolean | undefined;
		const flow = queue.withLease("a", (lease) =>
			withRoomDeliverySettlement(runtime, "a", lease, async () => {
				task = trackPostDeliveryTask(runtime, "captured", async () => {
					const captured = roomDeliverySettlement(runtime, "a");
					entered.resolve();
					await read.promise;
					observed = await captured;
				});
				return delivery.promise;
			}),
		);
		const outcome = flow.catch((error: unknown) => error);
		await entered.promise;
		quarantinePostDeliveryTasks(runtime, "external shutdown");
		delivery.reject(new Error("connector failed"));
		expect(await outcome).toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
		});
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(1);
		expect(await roomDeliverySettlement(runtime, "a")).toBe(true);
		read.resolve();
		await task;
		expect(observed).toBe(false);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
	});

	it("repeats drain batches and separates room state from other rooms and diagnostics", async () => {
		const queue = new RoomHandlerQueue({ asyncContext: "explicit" });
		const { runtime } = fixture(queue);
		const a = await queue.acquire("a");
		const b = await queue.acquire("b");
		const gates = Array.from({ length: 4 }, () => deferred<void>());
		try {
			const tasks = [
				trackPostDeliveryTask(runtime, "a", () => gates[0].promise, {
					kind: "room-state",
					roomId: "a",
					roomHandlerLease: a,
				}),
				trackPostDeliveryTask(runtime, "b", () => gates[1].promise, {
					kind: "room-state",
					roomId: "b",
					roomHandlerLease: b,
				}),
				trackPostDeliveryTask(runtime, "diagnostic", () => gates[2].promise, {
					kind: "diagnostic",
				}),
			];
			let roomDone = false;
			let allDone = false;
			const roomDrain = drainRoomPostDeliveryTasks(runtime, "a").then(
				(count) => {
					roomDone = true;
					return count;
				},
			);
			const runtimeDrain = drainPostDeliveryTasks(runtime).then((count) => {
				allDone = true;
				return count;
			});
			tasks.push(
				trackPostDeliveryTask(runtime, "late-a", () => gates[3].promise, {
					kind: "room-state",
					roomId: "a",
					roomHandlerLease: a,
				}),
			);
			await flush();
			gates[0].resolve();
			await tasks[0];
			await flush();
			expect(roomDone).toBe(false);
			expect(allDone).toBe(false);
			gates[3].resolve();
			expect(await roomDrain).toBe(2);
			expect(pendingRoomPostDeliveryTaskCount(runtime, "a")).toBe(0);
			expect(pendingPostDeliveryTaskCount(runtime)).toBe(2);
			expect(allDone).toBe(false);
			gates[1].resolve();
			gates[2].resolve();
			// The late room task settled before the first runtime batch. The
			// returned count includes observed batches, not every task ever admitted.
			expect(await runtimeDrain).toBe(3);
			await Promise.all(tasks);
		} finally {
			for (const gate of gates) gate.resolve();
			await a.release();
			await b.release();
		}
	});

	it("rechecks runtime work registered while its first batch is settling", async () => {
		const { runtime } = fixture();
		const first = deferred<void>();
		const late = deferred<void>();
		const firstTask = trackPostDeliveryTask(
			runtime,
			"first",
			() => first.promise,
		);
		let done = false;
		const drain = drainPostDeliveryTasks(runtime).then((count) => {
			done = true;
			return count;
		});
		const lateTask = trackPostDeliveryTask(runtime, "late", () => late.promise);
		first.resolve();
		await firstTask;
		await flush();
		expect(done).toBe(false);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(1);
		late.resolve();
		await lateTask;
		expect(await drain).toBe(2);
	});

	it("returns initially empty drains before consulting their aborted signal", async () => {
		const { runtime } = fixture();
		const controller = new AbortController();
		controller.abort(new Error("already aborted"));
		expect(
			await drainPostDeliveryTasks(runtime, { signal: controller.signal }),
		).toBe(0);
		expect(await drainRoomPostDeliveryTasks(runtime, "a")).toBe(0);
		expect(postDeliveryTaskQuarantineReason(runtime)).toBeUndefined();
		await trackPostDeliveryTask(runtime, "later", async () => {});
	});

	it("refuses queued callback invocation and future admissions after an aborted drain", async () => {
		const { runtime, errors } = fixture();
		let invoked = false;
		const queued = trackPostDeliveryTask(runtime, "queued", async () => {
			invoked = true;
		});
		const controller = new AbortController();
		controller.abort(new Error("shutdown deadline"));
		await expect(
			drainPostDeliveryTasks(runtime, { signal: controller.signal }),
		).rejects.toMatchObject({ code: "POST_DELIVERY_DRAIN_CANCELLED" });
		await queued;
		expect(invoked).toBe(false);
		expect(errors).toHaveLength(1);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
		expect(postDeliveryTaskQuarantineReason(runtime)).toBe(
			"post-delivery drain was cancelled",
		);
		expect(() =>
			trackPostDeliveryTask(runtime, "late", async () => {}, {
				kind: "diagnostic",
			}),
		).toThrowError(
			expect.objectContaining({ code: "POST_DELIVERY_RUNTIME_QUARANTINED" }),
		);
		await expect(drainPostDeliveryTasks(runtime)).rejects.toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
		});
		await expect(
			drainRoomPostDeliveryTasks(runtime, "a"),
		).rejects.toMatchObject({ code: "POST_DELIVERY_DRAIN_CANCELLED" });
	});

	it("retains a non-cooperative running task after cancellation until it actually settles", async () => {
		const { runtime, errors } = fixture();
		const entered = deferred<void>();
		const release = deferred<void>();
		let lateEffect = false;
		const stubborn = trackPostDeliveryTask(
			runtime,
			"non-cooperative",
			async () => {
				entered.resolve();
				await release.promise;
				lateEffect = true;
			},
		);
		const cooperative = trackPostDeliveryTask(
			runtime,
			"cooperative",
			async (signal) => {
				await new Promise<void>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					}),
				);
			},
		);
		await entered.promise;
		const controller = new AbortController();
		const drain = drainPostDeliveryTasks(runtime, {
			signal: controller.signal,
		});
		controller.abort();
		await expect(drain).rejects.toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
		});
		await cooperative;
		expect(errors).toHaveLength(1);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(1);
		expect(lateEffect).toBe(false);
		release.resolve();
		await stubborn;
		expect(lateEffect).toBe(true);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
		expect(postDeliveryTaskQuarantineReason(runtime)).toBeDefined();
	});

	it("lets an existing un-signalled drain finish after external quarantine", async () => {
		const { runtime } = fixture();
		const release = deferred<void>();
		const task = trackPostDeliveryTask(
			runtime,
			"running",
			() => release.promise,
		);
		await flush();
		const drain = drainPostDeliveryTasks(runtime);
		quarantinePostDeliveryTasks(runtime, "external shutdown");
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(1);
		release.resolve();
		await task;
		expect(await drain).toBe(1);
		await expect(drainPostDeliveryTasks(runtime)).rejects.toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
		});
	});
});
