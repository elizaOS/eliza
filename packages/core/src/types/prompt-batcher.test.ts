/**
 * Unit tests for the runtime surface of the prompt-batcher contract module:
 * BatcherDisposedError identity, discrimination from plain Errors, and
 * propagation through throw/catch and rejected promises — the patterns
 * dispose-path consumers rely on when catching drained-section failures.
 * Deterministic unit harness driving the real class; no mocks.
 */
import { describe, expect, it } from "vitest";
import { BatcherDisposedError } from "./prompt-batcher.ts";

describe("prompt-batcher types", () => {
	describe("BatcherDisposedError", () => {
		it("constructs an Error subclass instance", () => {
			const error = new BatcherDisposedError();
			expect(error).toBeInstanceOf(Error);
			expect(error).toBeInstanceOf(BatcherDisposedError);
			expect(error.constructor).toBe(BatcherDisposedError);
		});

		it("carries the disposal name and message verbatim", () => {
			const error = new BatcherDisposedError();
			expect(error.name).toBe("BatcherDisposedError");
			expect(error.message).toBe("PromptBatcher has been disposed");
		});

		it("distinguishes disposal failures from plain Errors via instanceof", () => {
			const disposed = new BatcherDisposedError();
			const generic = new Error("other failure");
			expect(disposed instanceof BatcherDisposedError).toBe(true);
			expect(generic instanceof BatcherDisposedError).toBe(false);
		});

		it("survives throw/catch with identity preserved", () => {
			const original = new BatcherDisposedError();
			let caught: unknown;
			try {
				throw original;
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(original);
			if (caught instanceof BatcherDisposedError) {
				expect(caught.message).toBe("PromptBatcher has been disposed");
				expect(caught.name).toBe("BatcherDisposedError");
			} else {
				throw new Error("caught value was not a BatcherDisposedError");
			}
		});

		it("rejects promises the way the batcher dispose path fails pending sections", async () => {
			const rejection = Promise.reject(new BatcherDisposedError());
			await expect(rejection).rejects.toBeInstanceOf(BatcherDisposedError);
			await expect(rejection).rejects.toMatchObject({
				name: "BatcherDisposedError",
				message: "PromptBatcher has been disposed",
			});
		});

		it("captures a stack trace pointing at the construction site", () => {
			const error = new BatcherDisposedError();
			expect(typeof error.stack).toBe("string");
			expect((error.stack ?? "").length).toBeGreaterThan(0);
			expect(error.stack).toContain("BatcherDisposedError");
		});
	});
});
