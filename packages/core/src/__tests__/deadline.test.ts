import { afterEach, describe, expect, it, vi } from "vitest";
import { rejectAtDeadline, resolveAtDeadline } from "../utils/deadline";

afterEach(() => vi.useRealTimers());

describe("promise deadlines", () => {
	it("clears the timeout when the source settles", async () => {
		vi.useFakeTimers();
		const onTimeout = vi.fn(() => "late");
		expect(
			await resolveAtDeadline(Promise.resolve("ready"), {
				timeoutMs: 10,
				onTimeout,
			}),
		).toBe("ready");
		expect(vi.getTimerCount()).toBe(0);
		expect(onTimeout).not.toHaveBeenCalled();
	});

	it.each([resolveAtDeadline, rejectAtDeadline])(
		"rejects when the timeout factory throws",
		async (deadline) => {
			vi.useFakeTimers();
			const error = new Error("factory failed");
			const result = deadline(new Promise<never>(() => {}), {
				timeoutMs: 10,
				onTimeout: () => {
					throw error;
				},
			});
			const assertion = expect(result).rejects.toBe(error);
			await vi.advanceTimersByTimeAsync(10);
			await assertion;
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("preserves source rejection", async () => {
		const error = new Error("source failed");
		await expect(
			rejectAtDeadline(Promise.reject(error), {
				timeoutMs: 100,
				onTimeout: () => new Error("late"),
			}),
		).rejects.toBe(error);
	});

	it("supports both timeout policies", async () => {
		vi.useFakeTimers();
		const source = new Promise<never>(() => {});
		const fallback = resolveAtDeadline(source, {
			timeoutMs: 10,
			onTimeout: () => "fallback",
		});
		const error = new Error("late");
		const rejection = expect(
			rejectAtDeadline(source, { timeoutMs: 10, onTimeout: () => error }),
		).rejects.toBe(error);
		await vi.advanceTimersByTimeAsync(10);
		expect(await fallback).toBe("fallback");
		await rejection;
	});
});
