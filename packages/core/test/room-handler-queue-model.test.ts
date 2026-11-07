/** Regression checks for properties of tla/RoomHandlerQueue.tla that the code once broke. */
import { describe, expect, it } from "vitest";
import { RoomHandlerQueue } from "../src/runtime/room-handler-queue";

const settlesWithin = <T>(promise: Promise<T>, ms: number) =>
	Promise.race([
		promise.then(() => "settled"),
		new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
	]);

describe("RoomHandlerQueue model properties", () => {
	it("reuses the ambient lease for a nested withLease on the same room (WaiterServed)", async () => {
		const queue = new RoomHandlerQueue();
		const nested = queue.withLease("a", () =>
			queue.withLease("a", async () => "inner"),
		);
		expect(await settlesWithin(nested, 200)).toBe("settled");
		await expect(nested).resolves.toBe("inner");
	});

	it("refuses a nested withLease that widens to another room (OrderedAcquisition)", async () => {
		const queue = new RoomHandlerQueue();
		await expect(
			queue.withLease("b", () => queue.withLease("a", async () => "inner")),
		).rejects.toMatchObject({ code: "ROOM_HANDLER_CROSS_ROOM_REENTRY" });
		expect(queue.pendingTotal()).toBe(0);
	});

	it("reuses a held room for a nested withLease inside withLeases (Nest)", async () => {
		const queue = new RoomHandlerQueue();
		const nested = queue.withLeases(["a", "b"], () =>
			queue.withLease("a", async () => "inner"),
		);
		expect(await settlesWithin(nested, 200)).toBe("settled");
		await expect(nested).resolves.toBe("inner");
		expect(queue.pendingTotal()).toBe(0);
	});

	it("refuses a nested withLease inside withLeases that widens to another room (OrderedAcquisition)", async () => {
		const queue = new RoomHandlerQueue();
		await expect(
			queue.withLeases(["b"], () => queue.withLease("a", async () => "inner")),
		).rejects.toMatchObject({ code: "ROOM_HANDLER_CROSS_ROOM_REENTRY" });
		expect(queue.pendingTotal()).toBe(0);
	});

	it("treats an ambient store whose leases are released as no ownership (withLeases continuation)", async () => {
		const queue = new RoomHandlerQueue();
		let continuation!: Promise<string>;
		await queue.withLeases(["a"], async () => {
			continuation = new Promise<string>((resolve, reject) => {
				setTimeout(() => {
					queue
						.withLeases(["b", "c"], async () => "later")
						.then(resolve, reject);
				}, 10);
			});
		});
		await expect(continuation).resolves.toBe("later");
		expect(queue.pendingTotal()).toBe(0);
	});
});
