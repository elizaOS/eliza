/**
 * Proves the runtime-scoped snapshot barrier closes admission atomically,
 * drains already accepted mutations, and remains closed through standby.
 */
import { describe, expect, test, vi } from "vitest";
import { SnapshotCaptureBarrier } from "./snapshot-capture-barrier.ts";

describe("SnapshotCaptureBarrier", () => {
	test("drains accepted mutations while rejecting every later admission", async () => {
		const barrier = new SnapshotCaptureBarrier();
		const first = barrier.admitMutation();
		const second = barrier.admitMutation();

		barrier.beginDraining();
		expect(() => barrier.admitMutation()).toThrowError(
			expect.objectContaining({
				code: "AGENT_SNAPSHOT_MUTATION_ADMISSION_CLOSED",
			}),
		);

		const drained = vi.fn();
		const wait = barrier.waitForDrain().then(drained);
		first.release();
		await Promise.resolve();
		expect(drained).not.toHaveBeenCalled();
		second.release();
		await wait;
		expect(drained).toHaveBeenCalledOnce();
		expect(barrier.status()).toEqual({
			activeMutations: 0,
			failure: null,
			phase: "draining",
		});
	});

	test("commits the one-way capturing to standby transition", async () => {
		const barrier = new SnapshotCaptureBarrier();
		barrier.beginDraining();
		await barrier.waitForDrain();
		barrier.beginCapturing();
		barrier.enterStandby();

		expect(barrier.status().phase).toBe("standby");
		expect(() => barrier.admitMutation()).toThrowError(
			expect.objectContaining({
				code: "AGENT_SNAPSHOT_MUTATION_ADMISSION_CLOSED",
			}),
		);
		expect(() => barrier.beginDraining()).toThrowError(
			expect.objectContaining({
				code: "AGENT_SNAPSHOT_CAPTURE_ALREADY_STARTED",
			}),
		);
	});

	test("records capture failure without reopening admission", () => {
		const barrier = new SnapshotCaptureBarrier();
		barrier.beginDraining();
		barrier.fail(new Error("checkpoint failed"));

		expect(barrier.status()).toEqual({
			activeMutations: 0,
			failure: "checkpoint failed",
			phase: "failed",
		});
		expect(() => barrier.admitMutation()).toThrow();
	});

	test("wakes a pending drain as a failure rather than proceeding to capture", async () => {
		const barrier = new SnapshotCaptureBarrier();
		barrier.admitMutation();
		barrier.beginDraining();
		const wait = barrier.waitForDrain();
		barrier.fail(new Error("runtime stop failed"));

		await expect(wait).rejects.toMatchObject({
			code: "AGENT_SNAPSHOT_BARRIER_INVARIANT",
		});
		expect(barrier.status()).toMatchObject({
			failure: "runtime stop failed",
			phase: "failed",
		});
	});
});
