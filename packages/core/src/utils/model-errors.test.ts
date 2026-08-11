/**
 * Unit tests for the structural model-error classifiers: `isModelProviderError`
 * (gates the planner-loop post-tool relay) and `modelProviderErrorStatus`.
 * Deterministic — plain constructed error shapes, no live model.
 */
import { describe, expect, it } from "vitest";
import {
	isModelProviderError,
	modelProviderErrorDetail,
	modelProviderErrorStatus,
} from "./model-errors";

function withStatus(status: number, message = "err"): Error {
	const err = new Error(message) as Error & { statusCode: number };
	err.statusCode = status;
	return err;
}

describe("modelProviderErrorStatus", () => {
	it("reads statusCode off the error", () => {
		expect(modelProviderErrorStatus(withStatus(400))).toBe(400);
	});

	it("reads a legacy `.status` field", () => {
		const err = new Error("boom") as Error & { status: number };
		err.status = 503;
		expect(modelProviderErrorStatus(err)).toBe(503);
	});

	it("unwraps the AI SDK RetryError `.lastError` envelope", () => {
		const retry = new Error("retries exhausted") as Error & {
			lastError: unknown;
		};
		retry.lastError = withStatus(429);
		expect(modelProviderErrorStatus(retry)).toBe(429);
	});

	it("unwraps a `.cause`-wrapped provider error (plugin-anthropic shape)", () => {
		const wrapped = new Error("[Anthropic] evaluate failed: bad request", {
			cause: withStatus(400),
		});
		expect(modelProviderErrorStatus(wrapped)).toBe(400);
	});

	it("returns undefined when no status is carried", () => {
		expect(modelProviderErrorStatus(new Error("plain"))).toBeUndefined();
		expect(modelProviderErrorStatus(new TypeError("bug"))).toBeUndefined();
	});
});

describe("isModelProviderError", () => {
	it("is true for provider HTTP errors (400/401/404/429/5xx)", () => {
		for (const status of [400, 401, 403, 404, 413, 429, 500, 502, 503, 529]) {
			expect(isModelProviderError(withStatus(status))).toBe(true);
		}
	});

	it("is true for a retry-envelope-wrapped provider error", () => {
		const retry = new Error("retries exhausted") as Error & {
			errors: unknown[];
		};
		retry.errors = [withStatus(500)];
		expect(isModelProviderError(retry)).toBe(true);
	});

	it("is true for network/transport errors (structural `.code`)", () => {
		const econnreset = new Error("socket hang up") as Error & { code: string };
		econnreset.code = "ECONNRESET";
		expect(isModelProviderError(econnreset)).toBe(true);

		const fetchFailed = new Error("fetch failed", {
			cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
		});
		expect(isModelProviderError(fetchFailed)).toBe(true);
	});

	it("is FALSE for programmer errors (TypeError with no status/code)", () => {
		expect(isModelProviderError(new TypeError("x is undefined"))).toBe(false);
		expect(isModelProviderError(new Error("something odd"))).toBe(false);
	});

	it("is FALSE for a schema-validation error shape (errors: string[])", () => {
		// SchemaValidationFailedError carries `errors: string[]` of validation
		// messages — those strings must not be mistaken for wrapped provider errors.
		const schemaErr = new Error("schema validation failed") as Error & {
			name: string;
			errors: string[];
		};
		schemaErr.name = "SchemaValidationFailedError";
		schemaErr.errors = ["expected object, got string", "429 appears in text"];
		expect(isModelProviderError(schemaErr)).toBe(false);
	});

	it("is FALSE for a sub-400 status", () => {
		expect(isModelProviderError(withStatus(200))).toBe(false);
	});
});

describe("modelProviderErrorDetail", () => {
	function apiCallError(args: {
		message?: string;
		statusCode?: number;
		responseBody?: string;
		url?: string;
	}): Error {
		return Object.assign(new Error(args.message ?? "Bad Request"), {
			statusCode: args.statusCode,
			responseBody: args.responseBody,
			url: args.url,
		});
	}

	it("recovers the FLAT Cerebras error shape the AI SDK masks to statusText", () => {
		// Live signature: Cerebras returns {"message","type","param","code"} with
		// no OpenAI {"error":{...}} wrapper, so APICallError.message is the bare
		// "Bad Request" while the actionable cause sits on responseBody.
		const detail = modelProviderErrorDetail(
			apiCallError({
				statusCode: 400,
				responseBody:
					'{"message":": Invalid JSON: lone leading surrogate in hex escape at line 1 column 135","type":"invalid_request_error","param":"validation_error","code":"wrong_api_format"}',
				url: "https://api.cerebras.ai/v1/chat/completions",
			}),
		);
		expect(detail).toBeDefined();
		expect(detail?.status).toBe(400);
		expect(detail?.providerMessage).toContain("lone leading surrogate");
		expect(detail?.responseBodyExcerpt).toContain("wrong_api_format");
		expect(detail?.url).toContain("cerebras");
	});

	it("recovers the OpenAI error envelope shape", () => {
		const detail = modelProviderErrorDetail(
			apiCallError({
				statusCode: 400,
				responseBody:
					'{"error":{"message":"context_length_exceeded: reduce your prompt","type":"invalid_request_error"}}',
			}),
		);
		expect(detail?.providerMessage).toContain("context_length_exceeded");
	});

	it("keeps a bounded excerpt of a non-JSON body instead of dropping it", () => {
		const detail = modelProviderErrorDetail(
			apiCallError({
				statusCode: 400,
				responseBody: `<html>upstream gateway rejected ${"x".repeat(1000)}</html>`,
			}),
		);
		expect(detail?.providerMessage).toBeUndefined();
		expect(detail?.responseBodyExcerpt).toContain("upstream gateway rejected");
		expect(detail?.responseBodyExcerpt?.length).toBeLessThanOrEqual(400);
	});

	it("walks the RetryError/cause chain for the body", () => {
		const retry = new Error("retries exhausted") as Error & {
			lastError: unknown;
		};
		retry.lastError = apiCallError({
			statusCode: 400,
			responseBody: '{"message":"please try again"}',
		});
		expect(modelProviderErrorDetail(retry)?.providerMessage).toBe(
			"please try again",
		);
	});

	it("is undefined when the chain carries neither status nor body", () => {
		expect(modelProviderErrorDetail(new Error("plain"))).toBeUndefined();
		expect(modelProviderErrorDetail(undefined)).toBeUndefined();
	});
});
