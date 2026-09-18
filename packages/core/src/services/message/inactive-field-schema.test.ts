/** Verifies inactive schema narrowing without changing the registered contract. */
import { describe, expect, it } from "vitest";
import { validateSchema } from "../../actions/validate-tool-args";
import type { JSONSchema } from "../../types/model";
import { withInactiveArrayFields } from "./inactive-field-schema";

describe("inactive array field schema", () => {
	it("requires the empty field without mutating the registered active contract", () => {
		const schema: JSONSchema = {
			type: "object",
			required: ["ops"],
			properties: {
				ops: {
					type: "array",
					items: { type: "object", properties: { action: { type: "string" } } },
				},
			},
		};
		const before = JSON.stringify(schema);
		const inactive = withInactiveArrayFields(schema, ["ops"]);
		const errors: string[] = [];
		validateSchema(inactive, { ops: [] }, "", errors);
		expect(errors).toEqual([]);
		validateSchema(inactive, { ops: [{ action: "stop" }] }, "", errors);
		expect(errors.length).toBeGreaterThan(0);
		const nonemptyStrings: string[] = [];
		const rejected = { ops: ["stop", "retain the complete invalid value"] };
		validateSchema(inactive, rejected, "", nonemptyStrings);
		expect(rejected.ops).toEqual(["stop", "retain the complete invalid value"]);
		expect(nonemptyStrings.length).toBeGreaterThan(0);
		const missing: string[] = [];
		validateSchema(inactive, {}, "", missing);
		expect(missing.length).toBeGreaterThan(0);
		const activeValue = {
			ops: Array.from({ length: 500 }, (_, index) => ({
				action: `complete operation ${index}`,
			})),
		};
		const activeErrors: string[] = [];
		expect(validateSchema(schema, activeValue, "", activeErrors)).toEqual(
			activeValue,
		);
		expect(activeErrors).toEqual([]);
		expect(JSON.stringify(schema)).toBe(before);
		expect(withInactiveArrayFields(schema, [])).toBe(schema);
	});

	it("preserves custom contracts and fields that cannot accept an empty array", () => {
		for (const field of [
			{ type: "string" },
			{ type: "array", minItems: 1, items: { type: "string" } },
			{ type: "array", enum: [["required"]] },
			{ type: "array", anyOf: [{ minItems: 1 }] },
		]) {
			const schema: JSONSchema = { type: "object", properties: { field } };
			expect(withInactiveArrayFields(schema, ["field", "unknown"])).toBe(
				schema,
			);
		}
	});
});
