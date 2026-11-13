/**
 * Which provider failures let useModel try the next registered provider. A
 * socket code counts on the error itself and on the cause and retry envelopes
 * the AI SDK wraps it in. The funding, processing-policy, cancellation and
 * TEXT_TO_SPEECH gates run first and keep such a failure terminal.
 */
import { describe, expect, it } from "vitest";
import { isModelProviderFallbackError } from "../src/security/model-failure.ts";
import { PROCESSING_POLICY_DENIED } from "../src/security/processing-policy.ts";
import { ModelType } from "../src/types/model.ts";

function socketError(code: string): Error {
	return Object.assign(new Error(`connect ${code} 127.0.0.1:9`), { code });
}

/** The AI SDK's refused-connection error: no code of its own, the socket error on `.cause`. */
function cannotConnect(code = "ECONNREFUSED"): Error {
	return Object.assign(
		new Error(`Cannot connect to API: connect ${code} 127.0.0.1:9`, {
			cause: socketError(code),
		}),
		{ name: "AI_APICallError" },
	);
}

/** A terminal error that also carries a refused connection on its cause. */
function terminal(fields: { name?: string; code?: string }): Error {
	return Object.assign(
		new Error("request stopped", { cause: socketError("ECONNREFUSED") }),
		fields,
	);
}

describe("isModelProviderFallbackError socket codes", () => {
	it.each([
		["a bare object", { code: "ECONNRESET" }],
		["an Error", socketError("ECONNREFUSED")],
		["an Error with Bun's code", socketError("ConnectionRefused")],
	])("keeps a code on %s itself", (_label, error) => {
		expect(isModelProviderFallbackError(error, ModelType.TEXT_SMALL)).toBe(
			true,
		);
	});

	it.each(["ECONNREFUSED", "ConnectionRefused"])(
		"reads %s on the AI SDK error's cause",
		(code) => {
			expect(
				isModelProviderFallbackError(cannotConnect(code), ModelType.TEXT_SMALL),
			).toBe(true);
		},
	);

	it("reads the code inside a retry envelope", () => {
		const lastError = cannotConnect();
		const retry = Object.assign(
			new Error("Failed after 3 attempts. Last error: Cannot connect to API"),
			{
				name: "AI_RetryError",
				reason: "maxRetriesExceeded",
				lastError,
				errors: [lastError],
			},
		);
		expect(isModelProviderFallbackError(retry, ModelType.TEXT_SMALL)).toBe(
			true,
		);
	});

	it.each([
		["funding authority", terminal({ code: "MODEL_FUNDING_AUTHORITY_FAILED" })],
		["processing policy", terminal({ code: PROCESSING_POLICY_DENIED })],
		["cancellation", terminal({ name: "AbortError" })],
	])("keeps a %s failure terminal", (_label, error) => {
		expect(isModelProviderFallbackError(error, ModelType.TEXT_SMALL)).toBe(
			false,
		);
	});

	it("keeps TEXT_TO_SPEECH terminal", () => {
		expect(
			isModelProviderFallbackError(cannotConnect(), ModelType.TEXT_TO_SPEECH),
		).toBe(false);
	});

	it("ignores a code that is not a socket failure", () => {
		expect(
			isModelProviderFallbackError(
				Object.assign(new Error("Invalid value for 'messages'"), {
					cause: { code: "invalid_request_error" },
				}),
				ModelType.TEXT_SMALL,
			),
		).toBe(false);
	});
});
