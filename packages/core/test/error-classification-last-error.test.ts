import { describe, expect, it } from "vitest";
import { shouldIgnoreUnhandledRejection } from "../src/error-classification.ts";

/** An `AI_APICallError` shape: name on the stack, status, optional body. */
function apiCallError(
	message: string,
	statusCode: unknown,
	responseBody?: string,
): Error {
	const error = new Error(message) as Error & {
		statusCode?: unknown;
		responseBody?: string;
	};
	error.name = "AI_APICallError";
	if (statusCode !== undefined) error.statusCode = statusCode;
	if (responseBody !== undefined) error.responseBody = responseBody;
	return error;
}

/** An `AI_RetryError` shape: the terminal failure lives on `lastError`. */
function retryError(lastError: unknown, withErrors = false): Error {
	const error = new Error("Failed after 3 attempts.") as Error & {
		lastError?: unknown;
		errors?: unknown[];
	};
	error.name = "AI_RetryError";
	error.lastError = lastError;
	if (withErrors) error.errors = [lastError];
	return error;
}

describe("shouldIgnoreUnhandledRejection RetryError envelope", () => {
	it("follows lastError to the 402 underneath", () => {
		const retry = retryError(apiCallError("Payment Required", 402));
		expect(shouldIgnoreUnhandledRejection(retry)).toBe(true);
	});

	it("accepts a numeric-string statusCode", () => {
		const retry = retryError(apiCallError("402", "402"), true);
		expect(shouldIgnoreUnhandledRejection(retry)).toBe(true);
	});

	it("accepts a status field instead of statusCode", () => {
		const error = apiCallError("402", undefined) as Error & {
			status?: unknown;
		};
		error.status = 402;
		expect(shouldIgnoreUnhandledRejection(error)).toBe(true);
	});

	it("still ignores a direct 402 APICallError", () => {
		expect(
			shouldIgnoreUnhandledRejection(apiCallError("Payment Required", 402)),
		).toBe(true);
	});

	it("does not ignore a non-credit failure behind lastError", () => {
		const retry = retryError(apiCallError("Internal Server Error", 500));
		expect(shouldIgnoreUnhandledRejection(retry)).toBe(false);
		expect(shouldIgnoreUnhandledRejection(new TypeError("boom"))).toBe(false);
	});
});
