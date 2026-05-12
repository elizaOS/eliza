import { describe, expect, it } from "vitest";
import { CleanupTimeoutError, withCleanup } from "../cleanup-scope";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (signal) {
			const onAbort = () => {
				clearTimeout(t);
				reject(new Error("cleanup-aborted"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

describe("withCleanup", () => {
	describe("happy path", () => {
		it("runs fn and does NOT run cleanup when signal is not aborted", async () => {
			const controller = new AbortController();
			let cleanupRan = false;
			const result = await withCleanup(
				controller.signal,
				1_000,
				async () => {
					cleanupRan = true;
				},
				async () => "fn-result",
			);
			expect(result).toBe("fn-result");
			expect(cleanupRan).toBe(false);
		});
	});

	describe("already-aborted signal", () => {
		it("runs cleanup, does NOT run fn, and returns undefined", async () => {
			const controller = new AbortController();
			controller.abort();

			let fnRan = false;
			let cleanupRan = false;

			const result = await withCleanup(
				controller.signal,
				1_000,
				async () => {
					cleanupRan = true;
				},
				async () => {
					fnRan = true;
					return "fn-result";
				},
			);

			expect(result).toBeUndefined();
			expect(fnRan).toBe(false);
			expect(cleanupRan).toBe(true);
		});
	});

	describe("fn throws while signal NOT aborted", () => {
		it("rethrows without running cleanup", async () => {
			const controller = new AbortController();
			let cleanupRan = false;
			await expect(
				withCleanup(
					controller.signal,
					1_000,
					async () => {
						cleanupRan = true;
					},
					async () => {
						throw new Error("fn-boom");
					},
				),
			).rejects.toThrow("fn-boom");
			expect(cleanupRan).toBe(false);
		});
	});

	describe("fn throws while signal IS aborted", () => {
		it("runs cleanup, rethrows the original error", async () => {
			const controller = new AbortController();
			let cleanupRan = false;
			let originalErr: unknown;

			try {
				await withCleanup(
					controller.signal,
					1_000,
					async () => {
						cleanupRan = true;
					},
					async () => {
						// Simulate: aborted mid-run, fn observed signal, threw.
						controller.abort();
						throw new Error("interrupted");
					},
				);
			} catch (err) {
				originalErr = err;
			}

			expect(cleanupRan).toBe(true);
			expect(originalErr).toBeInstanceOf(Error);
			expect((originalErr as Error).message).toBe("interrupted");
		});
	});

	describe("timeoutMs", () => {
		it("aborts cleanup signal after timeoutMs", async () => {
			const controller = new AbortController();
			controller.abort();

			let cleanupSeenAborted = false;
			let cleanupReason: unknown;

			const start = Date.now();
			await withCleanup(
				controller.signal,
				20,
				async (cleanupSignal) => {
					try {
						await sleep(500, cleanupSignal);
					} catch {
						cleanupSeenAborted = cleanupSignal.aborted;
						cleanupReason = cleanupSignal.reason;
					}
				},
				async () => "never",
			);
			const elapsed = Date.now() - start;

			expect(cleanupSeenAborted).toBe(true);
			expect(cleanupReason).toBeInstanceOf(CleanupTimeoutError);
			// Should bail well before the cleanup's 500ms target.
			expect(elapsed).toBeLessThan(200);
		});

		it("does NOT abort cleanup signal if cleanup completes in time", async () => {
			const controller = new AbortController();
			controller.abort();

			let observedAbortedDuring = false;
			await withCleanup(
				controller.signal,
				200,
				async (cleanupSignal) => {
					await sleep(10);
					observedAbortedDuring = cleanupSignal.aborted;
				},
				async () => "never",
			);
			expect(observedAbortedDuring).toBe(false);
		});
	});

	describe("CleanupTimeoutError", () => {
		it("carries .code = 'CLEANUP_TIMEOUT'", () => {
			const err = new CleanupTimeoutError(5_000);
			expect(err.code).toBe("CLEANUP_TIMEOUT");
			expect(err.message).toContain("5000");
			expect(err).toBeInstanceOf(Error);
		});
	});
});
