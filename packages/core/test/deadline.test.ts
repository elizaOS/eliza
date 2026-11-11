/** Node clamps any setTimeout delay above 2^31 - 1 ms to 1 ms, so a huge or
 * unbounded deadline must never arm a single timer with the raw value. */
import { describe, expect, it, vi } from "vitest";
import {
	rejectAtDeadline,
	resolveAtDeadline,
} from "../src/utils/deadline";

const MAX_TIMEOUT_MS = 2_147_483_647;

describe("resolveAtDeadline", () => {
	it("never times out on an unbounded (Infinity) deadline", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			const result = await resolveAtDeadline(Promise.resolve("done"), {
				timeoutMs: Infinity,
				onTimeout: () => "TIMEOUT",
			});
			expect(result).toBe("done");
			expect(setTimeoutSpy).not.toHaveBeenCalled();
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	it("waits for the source past the 32-bit timer limit instead of firing in 1 ms", async () => {
		const start = Date.now();
		const result = await resolveAtDeadline(
			new Promise<string>((resolve) => {
				setTimeout(() => resolve("done"), 25);
			}),
			{ timeoutMs: 2 ** 31, onTimeout: () => "TIMEOUT" },
		);
		expect(result).toBe("done");
		expect(Date.now() - start).toBeGreaterThanOrEqual(20);
	});

	it("arms chunked timers no larger than the 32-bit limit for huge deadlines", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			const result = await resolveAtDeadline(Promise.resolve("done"), {
				timeoutMs: MAX_TIMEOUT_MS + 1000,
				onTimeout: () => "TIMEOUT",
			});
			expect(result).toBe("done");
			expect(setTimeoutSpy).toHaveBeenCalled();
			for (const call of setTimeoutSpy.mock.calls) {
				expect(call[1]).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
			}
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	it("still fires a normal timeout", async () => {
		const result = await resolveAtDeadline(
			new Promise<string>(() => {}),
			{ timeoutMs: 5, onTimeout: () => "TIMEOUT" },
		);
		expect(result).toBe("TIMEOUT");
	});
});

describe("rejectAtDeadline", () => {
	it("never rejects on an unbounded (Infinity) deadline", async () => {
		const result = await rejectAtDeadline(Promise.resolve("done"), {
			timeoutMs: Infinity,
			onTimeout: () => new Error("timed out"),
		});
		expect(result).toBe("done");
	});

	it("still rejects on a normal timeout", async () => {
		await expect(
			rejectAtDeadline(new Promise<string>(() => {}), {
				timeoutMs: 5,
				onTimeout: () => new Error("timed out"),
			}),
		).rejects.toThrow("timed out");
	});
});
