/** Deterministic unit coverage for Semaphore capacity, contention, FIFO waiter handoff, tryAcquire, and withPermit. */

import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore";

describe("Semaphore", () => {
	it("initializes with valid count and tracks available permits", () => {
		const sem = new Semaphore(3);
		expect(sem.availablePermits).toBe(3);
		expect(sem.queueLength).toBe(0);
	});

	it("sanitizes non-finite, negative, or non-numeric counts to minimum 1", () => {
		const semNaN = new Semaphore(Number.NaN);
		expect(semNaN.availablePermits).toBe(1);
		expect(new Semaphore(Number.POSITIVE_INFINITY).availablePermits).toBe(1);
		expect(new Semaphore(Number.NEGATIVE_INFINITY).availablePermits).toBe(1);

		const semNeg = new Semaphore(-5);
		expect(semNeg.availablePermits).toBe(1);

		const semZero = new Semaphore(0);
		expect(semZero.availablePermits).toBe(1);

		const semFloat = new Semaphore(2.7);
		expect(semFloat.availablePermits).toBe(2);
	});

	it("acquires and releases permits correctly", async () => {
		const sem = new Semaphore(2);

		await sem.acquire();
		expect(sem.availablePermits).toBe(1);

		await sem.acquire();
		expect(sem.availablePermits).toBe(0);

		sem.release();
		expect(sem.availablePermits).toBe(1);

		sem.release();
		expect(sem.availablePermits).toBe(2);
	});

	it("queues waiters when permits are exhausted and resumes them on release", async () => {
		const sem = new Semaphore(1);
		await sem.acquire();
		expect(sem.availablePermits).toBe(0);

		let taskCompleted = false;
		const waitingTask = (async () => {
			await sem.acquire();
			taskCompleted = true;
			sem.release();
		})();

		expect(sem.queueLength).toBe(1);
		expect(taskCompleted).toBe(false);

		sem.release();
		await waitingTask;

		expect(taskCompleted).toBe(true);
		expect(sem.queueLength).toBe(0);
		expect(sem.availablePermits).toBe(1);
	});

	it("supports tryAcquire and prevents barging when waiters are queued", async () => {
		const sem = new Semaphore(1);
		expect(sem.tryAcquire()).toBe(true);
		expect(sem.availablePermits).toBe(0);
		expect(sem.tryAcquire()).toBe(false);

		let waiterAcquired = false;
		const waiter = (async () => {
			await sem.acquire();
			waiterAcquired = true;
			sem.release();
		})();

		expect(sem.queueLength).toBe(1);
		expect(sem.tryAcquire()).toBe(false);

		sem.release();
		await waiter;

		expect(waiterAcquired).toBe(true);
		expect(sem.queueLength).toBe(0);
		expect(sem.availablePermits).toBe(1);
	});

	it("serializes concurrent withPermit callers in FIFO order and prevents starvation on error", async () => {
		const sem = new Semaphore(1);
		const executionOrder: string[] = [];
		let currentInFlight = 0;
		let maxInFlight = 0;

		const runTask = (name: string, shouldFail = false) =>
			sem.withPermit(async () => {
				currentInFlight += 1;
				maxInFlight = Math.max(maxInFlight, currentInFlight);
				executionOrder.push(`${name}-start`);

				await new Promise((resolve) => setTimeout(resolve, 5));

				executionOrder.push(`${name}-end`);
				currentInFlight -= 1;
				if (shouldFail) {
					throw new Error(`${name}-error`);
				}
				return `${name}-ok`;
			});

		const p1 = runTask("task1", true);
		const p2 = runTask("task2", false);
		const p3 = runTask("task3", false);

		await expect(p1).rejects.toThrow("task1-error");
		await expect(p2).resolves.toBe("task2-ok");
		await expect(p3).resolves.toBe("task3-ok");

		expect(maxInFlight).toBe(1);
		expect(executionOrder).toEqual([
			"task1-start",
			"task1-end",
			"task2-start",
			"task2-end",
			"task3-start",
			"task3-end",
		]);
		expect(sem.availablePermits).toBe(1);
		expect(sem.queueLength).toBe(0);
	});
});
