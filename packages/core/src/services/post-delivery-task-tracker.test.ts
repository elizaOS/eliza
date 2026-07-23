/**
 * Exercises real promise scheduling for tracked post-delivery work, including
 * tasks spawned by tasks and failure reporting at the detached boundary.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	drainPostDeliveryTasks,
	pendingPostDeliveryTaskCount,
	trackPostDeliveryTask,
} from "./post-delivery-task-tracker.ts";

function runtimeStub() {
	return {
		agentId: "00000000-0000-4000-8000-000000000001",
		reportError: vi.fn(),
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
});
