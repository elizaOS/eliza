/**
 * Exercises real promise scheduling for tracked post-delivery work, including
 * tasks spawned by tasks and failure reporting at the detached boundary.
 */
import { describe, expect, it, vi } from "vitest";
import { RoomHandlerQueue } from "../runtime/room-handler-queue.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	drainPostDeliveryTasks,
	drainRoomPostDeliveryTasks,
	pendingPostDeliveryTaskCount,
	pendingRoomPostDeliveryTaskCount,
	postDeliveryTaskQuarantineReason,
	trackPostDeliveryTask,
} from "./post-delivery-task-tracker.ts";

function runtimeStub(roomHandlerQueue?: RoomHandlerQueue) {
	return {
		agentId: "00000000-0000-4000-8000-000000000001",
		reportError: vi.fn(),
		roomHandlerQueue,
	} as unknown as Pick<IAgentRuntime, "agentId" | "reportError">;
}

describe("post-delivery task tracker", () => {
	it("drains nested work before reporting quiescence", async () => {
		const runtime = runtimeStub();
		const order: string[] = [];
		trackPostDeliveryTask(runtime, "outer", async () => {
			order.push("outer");
			trackPostDeliveryTask(runtime, "inner", async () => {
				await Promise.resolve();
				order.push("inner");
			});
		});

		expect(pendingPostDeliveryTaskCount(runtime)).toBe(1);
		const drained = await drainPostDeliveryTasks(runtime);

		expect(drained).toBe(1);
		expect(order).toEqual(["outer", "inner"]);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
	});

	it("reports failures and still drains", async () => {
		const runtime = runtimeStub();
		trackPostDeliveryTask(runtime, "broken", async () => {
			throw new Error("post-turn failed");
		});

		await drainPostDeliveryTasks(runtime);

		expect(runtime.reportError).toHaveBeenCalledWith(
			"PostDeliveryTask",
			expect.objectContaining({ message: "post-turn failed" }),
			expect.objectContaining({ label: "broken" }),
		);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
	});

	it("cancels cooperative work and quarantines uncooperative work", async () => {
		const runtime = runtimeStub();
		let cooperativeAborted = false;
		let releaseUncooperative!: () => void;
		trackPostDeliveryTask(runtime, "cooperative", async (signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						cooperativeAborted = true;
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		});
		const uncooperative = trackPostDeliveryTask(
			runtime,
			"uncooperative",
			async () => {
				await new Promise<void>((resolve) => {
					releaseUncooperative = resolve;
				});
			},
		);
		const controller = new AbortController();
		const draining = drainPostDeliveryTasks(runtime, {
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort(new Error("test deadline"));

		await expect(draining).rejects.toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
		});
		expect(cooperativeAborted).toBe(true);
		expect(postDeliveryTaskQuarantineReason(runtime)).toBe("test deadline");
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(1);
		await expect(drainPostDeliveryTasks(runtime)).rejects.toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
		});
		expect(() =>
			trackPostDeliveryTask(runtime, "late", async () => undefined),
		).toThrowError(
			expect.objectContaining({ code: "POST_DELIVERY_RUNTIME_QUARANTINED" }),
		);
		releaseUncooperative();
		await uncooperative;
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
	});

	it("retains quarantine membership when cancellation has an empty message", async () => {
		const runtime = runtimeStub();
		let releaseUncooperative!: () => void;
		const uncooperative = trackPostDeliveryTask(
			runtime,
			"empty-message-uncooperative",
			async () =>
				new Promise<void>((resolve) => {
					releaseUncooperative = resolve;
				}),
		);
		const controller = new AbortController();
		const draining = drainPostDeliveryTasks(runtime, {
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort(new Error());

		await expect(draining).rejects.toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
			context: { reason: "post-delivery drain was cancelled" },
		});
		expect(postDeliveryTaskQuarantineReason(runtime)).toBe(
			"post-delivery drain was cancelled",
		);
		expect(() =>
			trackPostDeliveryTask(runtime, "late", async () => undefined),
		).toThrowError(
			expect.objectContaining({ code: "POST_DELIVERY_RUNTIME_QUARANTINED" }),
		);

		releaseUncooperative();
		await uncooperative;
	});

	it("treats unclassified room work as state-bearing and drains it before ownership ends", async () => {
		const roomId = "00000000-0000-4000-8000-000000000002";
		const queue = new RoomHandlerQueue();
		const runtime = runtimeStub(queue);
		const lease = await queue.acquire(roomId);
		let releaseTask!: () => void;
		const taskGate = new Promise<void>((resolve) => {
			releaseTask = resolve;
		});

		queue.runInLease(roomId, lease, () => {
			trackPostDeliveryTask(runtime, "new-room-task", async () => taskGate);
		});
		expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(1);

		releaseTask();
		await drainRoomPostDeliveryTasks(runtime, roomId);
		expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(0);
		await lease.release();
	});

	it("requires and drains explicit room ownership without async-local context", async () => {
		const roomId = "00000000-0000-4000-8000-000000000003";
		const queue = new RoomHandlerQueue({ asyncContext: "explicit" });
		const runtime = runtimeStub(queue);
		expect(() =>
			trackPostDeliveryTask(
				runtime,
				"unowned-room-task",
				async () => undefined,
			),
		).toThrowError(
			expect.objectContaining({
				code: "POST_DELIVERY_ROOM_OWNERSHIP_REQUIRED",
			}),
		);

		const lease = await queue.acquire(roomId);
		let releaseTask!: () => void;
		const taskGate = new Promise<void>((resolve) => {
			releaseTask = resolve;
		});
		trackPostDeliveryTask(runtime, "explicit-room-task", async () => taskGate, {
			kind: "room-state",
			roomId,
			roomHandlerLease: lease,
		});
		expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(1);

		releaseTask();
		await drainRoomPostDeliveryTasks(runtime, roomId);
		await lease.release();
		expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(0);
	});
});
