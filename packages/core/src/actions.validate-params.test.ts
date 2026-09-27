/** validateActionParams reports every supplied value that fails its declared schema, including optional parameters, instead of discarding or replacing it. */
import { describe, expect, it } from "vitest";
import { validateActionParams } from "./actions";
import type { Action } from "./types";

const action: Action = {
	name: "DEMO",
	description: "demo action",
	similes: [],
	examples: [],
	validate: async () => true,
	handler: async () => ({ success: true }),
	parameters: [
		{
			name: "range",
			description: "bounded optional number",
			required: false,
			schema: { type: "number", minimum: 0, maximum: 100 },
		},
		{
			name: "limit",
			description: "bounded optional integer with a default",
			required: false,
			schema: { type: "integer", minimum: 1, maximum: 10, default: 5 },
		},
		{
			name: "token",
			description: "required address",
			required: true,
			schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
		},
	],
};

const token = `0x${"a".repeat(40)}`;

describe("validateActionParams optional parameters (#32849)", () => {
	it("accepts valid values and applies defaults only when omitted", () => {
		expect(validateActionParams(action, { range: 50, token })).toEqual({
			valid: true,
			params: { range: 50, limit: 5, token },
			errors: [],
		});
	});

	it("reports an out-of-range optional number instead of dropping it", () => {
		const result = validateActionParams(action, { range: 500, token });
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			"Parameter 'range' value 500 is above maximum 100",
		]);
		expect(result.params).not.toHaveProperty("range");
	});

	it("reports an invalid optional integer instead of substituting its default", () => {
		const tooLarge = validateActionParams(action, { limit: 50, token });
		expect(tooLarge.valid).toBe(false);
		expect(tooLarge.errors).toEqual([
			"Parameter 'limit' value 50 is above maximum 10",
		]);
		expect(tooLarge.params).not.toHaveProperty("limit");

		const fractional = validateActionParams(action, { limit: 2.5, token });
		expect(fractional.valid).toBe(false);
		expect(fractional.errors).toEqual([
			"Parameter 'limit' expected integer, got 2.5",
		]);
	});

	it("still reports required violations", () => {
		expect(validateActionParams(action, { range: 50 }).errors).toEqual([
			"Required parameter 'token' was not provided for action DEMO",
		]);
	});
});
