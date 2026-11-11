/** Regression: an explicit-lease withLease must not drop sibling-room ownership from the ambient store. */
import { describe, expect, it } from "vitest";
import { RoomHandlerQueue } from "../src/runtime/room-handler-queue";

describe("RoomHandlerQueue ambient ownership merge", () => {
	it("keeps sibling room leases visible inside an explicit-lease withLease on a third room", async () => {
		const queue = new RoomHandlerQueue();
		await queue.withLeases(["a", "b"], async (leases) => {
			const leaseC = await queue.acquire("c");
			try {
				expect(queue.currentLease("a")).toBe(leases.get("a"));
				await queue.withLease(
					"c",
					async () => {
						expect(queue.currentLease("a")).toBe(leases.get("a"));
						expect(queue.currentLease("b")).toBe(leases.get("b"));
						expect(queue.currentLease("c")).toBe(leaseC);
					},
					{ lease: leaseC },
				);
			} finally {
				await leaseC.release();
			}
		});
		expect(queue.pendingTotal()).toBe(0);
	});
});
