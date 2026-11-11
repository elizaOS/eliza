import { expect, test } from "vitest";
import { isTimeoutError } from "../src/utils/errors";

test("isTimeoutError rejects a manual abort", () => {
	// A user-cancelled operation is an AbortError with no timeout wording.
	// It must not be classified as a timeout (and retried as one).
	expect(
		isTimeoutError(new DOMException("The operation was aborted", "AbortError")),
	).toBe(false);
	expect(isTimeoutError(new DOMException("AbortError", "AbortError"))).toBe(
		false,
	);
});

test("isTimeoutError still accepts real timeouts", () => {
	expect(
		isTimeoutError(new DOMException("The operation timed out", "TimeoutError")),
	).toBe(true);
	expect(
		isTimeoutError(new DOMException("The operation timed out", "AbortError")),
	).toBe(true);
	expect(isTimeoutError(new Error("request timed out"))).toBe(true);
	expect(isTimeoutError(new Error("connection timeout"))).toBe(true);
	expect(isTimeoutError("timed out")).toBe(true);
});

test("isTimeoutError rejects other errors and values", () => {
	expect(isTimeoutError(new Error("boom"))).toBe(false);
	expect(isTimeoutError("boom")).toBe(false);
	expect(isTimeoutError(null)).toBe(false);
	expect(isTimeoutError(undefined)).toBe(false);
	expect(isTimeoutError(42)).toBe(false);
	expect(isTimeoutError({})).toBe(false);
});
