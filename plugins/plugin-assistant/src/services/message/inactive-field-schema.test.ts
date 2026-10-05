/** Verifies inactive schema narrowing without changing the registered contract. */

import type { JSONSchema } from "@elizaos/core";
import { validateSchema } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { withoutInactiveFields } from "./inactive-field-schema.ts";

describe("inactive array field schema", () => {
  it("omits inactive operations while preserving the registered active contract", () => {
    const schema: JSONSchema = {
      type: "object",
      required: ["ops"],
      additionalProperties: false,
      properties: {
        ops: {
          type: "array",
          items: { type: "object", properties: { action: { type: "string" } } },
        },
      },
    };
    const before = JSON.stringify(schema);
    const inactive = withoutInactiveFields(schema, ["ops"]);
    const errors: string[] = [];
    validateSchema(inactive, {}, "", errors);
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
    expect(missing).toEqual([]);
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
    expect(withoutInactiveFields(schema, [])).toBe(schema);
  });

  it("omits inactive custom fields without changing their active contracts", () => {
    for (const field of [
      { type: "string" },
      { type: "array", minItems: 1, items: { type: "string" } },
      { type: "array", enum: [["required"]] },
      { type: "array", anyOf: [{ minItems: 1 }] },
    ]) {
      const schema: JSONSchema = { type: "object", properties: { field } };
      expect(
        withoutInactiveFields(schema, ["field", "unknown"]).properties,
      ).toEqual({});
      expect(schema.properties?.field).toBe(field);
    }
  });
});
