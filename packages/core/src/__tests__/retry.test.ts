import { afterEach, describe, expect, it, vi } from "vitest";
import { retryAsync } from "../utils/retry";

afterEach(() => vi.useRealTimers());

describe("retry policies", () => {
	it.each([3, { attempts: 3, minDelayMs: 0 }])(
		"preserves attempts and the final failure",
		async (options) => {
			const error = new Error("unavailable");
			const fn = vi.fn(async () => {
				throw error;
			});
			await expect(retryAsync(fn, options, 0)).rejects.toBe(error);
			expect(fn).toHaveBeenCalledTimes(3);
		},
	);
	it("bounds non-finite numeric attempts", async () => {
		const fn = vi.fn(async () => {
			throw new Error("unavailable");
		});
		await expect(retryAsync(fn, Number.POSITIVE_INFINITY, 0)).rejects.toThrow(
			"unavailable",
		);
		expect(fn).toHaveBeenCalledTimes(3);
	});
	it("cancels a backoff without invoking another attempt", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const reason = new Error("cancelled");
		const fn = vi.fn(async () => {
			throw new Error("retryable");
		});
		const result = retryAsync(fn, {
			signal: controller.signal,
			onRetry: () => controller.abort(reason),
		});
		await expect(result).rejects.toBe(reason);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
