/**
 * Deterministic final-wire admission coverage proves zero-dispatch rejection,
 * byte-identical retry validation, immutable request graphs, and content-free
 * typed failures without mocking a provider transport.
 */

import { describe, expect, it } from "vitest";
import { createPreparedModelRequestGuard } from "./prepared-model-request";

describe("createPreparedModelRequestGuard", () => {
	it("admits and rechecks one byte-identical request on every retry", () => {
		const request = {
			model: "gpt-5.6-luna",
			messages: [{ role: "user", content: "complete request" }],
			max_output_tokens: 128_000,
		};
		const countedBodies: string[] = [];
		const guard = createPreparedModelRequestGuard({
			provider: "openai",
			model: request.model,
			projectRequest: () => request,
			outputReserveTokens: request.max_output_tokens,
			countInputTokens: (body) => {
				countedBodies.push(body);
				return 17;
			},
		});

		guard.assertBeforeAttempt();
		guard.assertBeforeAttempt();

		expect(guard.attempts).toBe(2);
		expect(guard.budget).toMatchObject({
			contextWindowTokens: 1_050_000,
			outputReserveTokens: 128_000,
			inputTokens: 17,
			countSource: "provider-tokenizer",
		});
		expect(new Set(countedBodies).size).toBe(1);
		expect(Object.isFrozen(request)).toBe(true);
		expect(Object.isFrozen(request.messages)).toBe(true);
		expect(Object.isFrozen(request.messages[0])).toBe(true);
	});

	it("rejects an oversized prepared request before a transport can run", () => {
		let dispatches = 0;
		expect(() => {
			createPreparedModelRequestGuard({
				provider: "fixture",
				model: "tiny",
				projectRequest: () => ({ prompt: "raw-canary-must-not-leak" }),
				contextWindowTokens: 100,
				outputReserveTokens: 20,
				countInputTokens: () => 80,
			});
			dispatches += 1;
		}).toThrow(
			expect.objectContaining({
				code: "MODEL_INPUT_OVER_BUDGET",
				context: expect.not.objectContaining({
					request: expect.anything(),
				}),
			}),
		);
		expect(dispatches).toBe(0);
	});

	it("detects mutation between retry attempts", () => {
		let prompt = "first";
		const guard = createPreparedModelRequestGuard({
			provider: "fixture",
			model: "unknown-model",
			projectRequest: () => ({ prompt }),
			countInputTokens: () => 1,
		});
		guard.assertBeforeAttempt();
		prompt = "changed";
		expect(() => guard.assertBeforeAttempt()).toThrow(
			expect.objectContaining({ code: "MODEL_PREPARED_REQUEST_MUTATED" }),
		);
		expect(guard.attempts).toBe(1);
	});

	it("guards an already serialized final-wire body byte for byte", () => {
		let body = '{"model":"fixture","input":"complete"}';
		const guard = createPreparedModelRequestGuard({
			provider: "fixture",
			model: "fixture",
			serializeRequest: () => body,
			contextWindowTokens: 100_000,
			outputReserveTokens: 100,
		});
		guard.assertBeforeAttempt();
		expect(guard.budget.countSource).toBe("utf8-upper-bound");
		body = '{"model":"fixture", "input":"complete"}';
		expect(() => guard.assertBeforeAttempt()).toThrow(
			expect.objectContaining({ code: "MODEL_PREPARED_REQUEST_MUTATED" }),
		);
	});

	it("uses a UTF-8 upper bound when no provider tokenizer is available", () => {
		let dispatches = 0;
		expect(() => {
			createPreparedModelRequestGuard({
				provider: "fixture",
				model: "fixture",
				serializeRequest: () => "界".repeat(50),
				contextWindowTokens: 10_150,
				outputReserveTokens: 20,
			});
			dispatches += 1;
		}).toThrow(expect.objectContaining({ code: "MODEL_INPUT_OVER_BUDGET" }));
		expect(dispatches).toBe(0);
	});

	it("rejects values JSON would silently omit", () => {
		expect(() =>
			createPreparedModelRequestGuard({
				provider: "fixture",
				model: "unknown-model",
				projectRequest: () => ({ prompt: "ok", hidden: () => "lost" }),
			}),
		).toThrow(
			expect.objectContaining({
				code: "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED",
			}),
		);
	});

	it("fails closed when tokenizer counts drift for the same body", () => {
		let count = 4;
		const guard = createPreparedModelRequestGuard({
			provider: "fixture",
			model: "unknown-model",
			projectRequest: () => ({ prompt: "same" }),
			countInputTokens: () => count++,
		});
		expect(() => guard.assertBeforeAttempt()).toThrow(
			expect.objectContaining({
				code: "MODEL_PREPARED_REQUEST_TOKEN_COUNT_DRIFT",
			}),
		);
	});
});
