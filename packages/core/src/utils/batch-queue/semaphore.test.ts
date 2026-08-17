/**
 * Unit tests for Semaphore in packages/core/src/utils/batch-queue/semaphore.ts.
 */

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
});
