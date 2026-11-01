import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/utils/task-scheduling";

describe("Semaphore cancellation", () => {
	it("keeps existing no-signal callers in FIFO order", async () => {
		const semaphore = new Semaphore(1),
			order: number[] = [];
		await semaphore.acquire();
		const waiting = [0, 1, 2].map((index) =>
			semaphore.acquire().then(() => order.push(index)),
		);
		expect(semaphore.queueLength).toBe(3);
		for (const promise of waiting) {
			semaphore.release();
			await promise;
		}
		expect(order).toEqual([0, 1, 2]);
		semaphore.release();
		expect(semaphore.availablePermits).toBe(1);
	});

	it.each([0, 1, 2])(
		"removes cancelled queue position %s without losing a permit",
		async (cancelled) => {
			const semaphore = new Semaphore(1),
				order: number[] = [];
			await semaphore.acquire();
			const controllers = [
				new AbortController(),
				new AbortController(),
				new AbortController(),
			];
			const waiting = controllers.map((controller, index) =>
				semaphore.acquire(controller.signal).then(
					() => {
						order.push(index);
						return { granted: true };
					},
					(error) => ({ error }),
				),
			);
			const reason = new Error("queued cancellation");
			controllers[cancelled].abort(reason);
			expect(await waiting[cancelled]).toEqual({ error: reason });
			expect(semaphore.queueLength).toBe(2);
			for (const [index, promise] of waiting.entries()) {
				if (index === cancelled) continue;
				semaphore.release();
				await promise;
			}
			expect(order).toEqual([0, 1, 2].filter((index) => index !== cancelled));
			semaphore.release();
			expect(semaphore.availablePermits).toBe(1);
			expect(semaphore.queueLength).toBe(0);
		},
	);

	it("does not consume a permit for a pre-aborted caller", async () => {
		const semaphore = new Semaphore(1),
			controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);
		await expect(semaphore.acquire(controller.signal)).rejects.toBe(reason);
		expect(semaphore.availablePermits).toBe(1);
		expect(semaphore.queueLength).toBe(0);
	});

	it("leaves release ownership with a caller cancelled after admission", async () => {
		const semaphore = new Semaphore(1),
			controller = new AbortController();
		await semaphore.acquire(controller.signal);
		controller.abort();
		expect(semaphore.availablePermits).toBe(0);
		semaphore.release();
		expect(semaphore.availablePermits).toBe(1);
	});

	it("does not reject or release twice when cancellation follows a queued grant", async () => {
		const semaphore = new Semaphore(1),
			controller = new AbortController();
		await semaphore.acquire();
		const waiting = semaphore.acquire(controller.signal);
		semaphore.release();
		controller.abort();
		await waiting;
		expect(semaphore.availablePermits).toBe(0);
		expect(semaphore.queueLength).toBe(0);
		semaphore.release();
		expect(semaphore.availablePermits).toBe(1);
	});
});
