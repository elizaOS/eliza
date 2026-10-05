import { describe, expect, it } from "vitest";
import { getErrorMessage } from "../protocol.js";
import { formatError, formatErrorWithStack } from "./errors.js";
import { isTransientModelError } from "./model-errors.js";

describe("model error diagnostics", () => {
	it("preserves message-only and stack-first contracts", () => {
		const error = new Error("service temporarily unavailable");
		expect(getErrorMessage(error)).toBe(error.message);
		expect(formatError(error)).toBe(error.message);
		expect(formatErrorWithStack(error)).toBe(error.stack);
		expect(isTransientModelError(error)).toBe(true);
		expect(
			isTransientModelError(
				Object.assign(error, { code: "MODEL_FUNDING_AUTHORITY_FAILED" }),
			),
		).toBe(false);
	});

	it("keeps malformed thrown values printable without inventing retry eligibility", () => {
		const hostileMessage = Object.defineProperty(new Error(), "message", {
			get() {
				throw new Error("hostile message");
			},
		});
		const hostileCoercion = {
			[Symbol.toPrimitive]() {
				throw new Error("hostile coercion");
			},
		};
		const hostileTag = Object.defineProperty(
			{ ...hostileCoercion },
			Symbol.toStringTag,
			{
				get() {
					throw new Error("hostile tag");
				},
			},
		);
		const cases: Array<[unknown, string]> = [
			[Object.create(null), "[object Object]"],
			[hostileMessage, "[object Error]"],
			[hostileCoercion, "[object Object]"],
			[hostileTag, "[unstringifiable error]"],
		];
		for (const [value, expected] of cases) {
			expect(getErrorMessage(value)).toBe(expected);
			expect(isTransientModelError(value)).toBe(false);
		}
	});
});
