/**
 * Verifies lossless response-schema factoring, including opaque data and schemas
 * whose reference resolution or custom semantics must remain untouched.
 */
import type { JSONSchema7 } from "ai";
import { describe, expect, it } from "vitest";
import { factorResponseSchema } from "../utils/factor-response-schema";

const field = {
  type: "string",
  description: "Preserve the exact original source, including punctuation and whitespace. ".repeat(
    5
  ),
  minLength: 1,
};
const schema = {
  type: "object",
  properties: { original: field, correction: field },
  required: ["original"],
  additionalProperties: false,
} as JSONSchema7;
function expand(value: unknown, definitions: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => expand(item, definitions));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") return definitions[record.$ref.replace("#/$defs/", "")];
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "$defs")
      .map(([key, child]) => [key, expand(child, definitions)])
  );
}
describe("factorResponseSchema", () => {
  it("retains every original field, constraint and optional property without mutation", () => {
    const before = structuredClone(schema);
    const result = factorResponseSchema(schema);
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(schema).length);
    expect(expand(result, result.$defs as Record<string, unknown>)).toEqual(before);
    expect(schema).toEqual(before);
  });
  it.each(["$ref", "$id", "$schema", "$anchor", "$defs", "definitions", "customValidation"])(
    "leaves %s semantics untouched",
    (key) => {
      const input = { ...schema, [key]: "opaque" };
      expect(factorResponseSchema(input)).toBe(input);
    }
  );
  it("does not treat property names or example/default values as schema keywords", () => {
    const input = {
      ...schema,
      properties: { type: field, $ref: field },
      default: { $ref: "literal", type: field },
      examples: [{ type: field }],
    } as JSONSchema7;
    const result = factorResponseSchema(input);
    expect(result.default).toEqual(input.default);
    expect(result.examples).toEqual(input.examples);
    expect(result.properties?.type).toHaveProperty("$ref");
    expect(result.properties?.$ref).toHaveProperty("$ref");
  });
  it("preserves nested and array constraints under expansion", () => {
    const input = {
      type: "object",
      properties: {
        a: { anyOf: [schema, false] },
        b: { type: "array", items: [schema, true] },
        c: schema,
      },
      additionalProperties: false,
    } as JSONSchema7;
    const result = factorResponseSchema(input);
    expect(expand(result, result.$defs as Record<string, unknown>)).toEqual(input);
  });
  it("leaves unsupported nested keywords and small schemas unchanged", () => {
    const input = {
      ...schema,
      properties: { ...schema.properties, custom: { customValidation: true } },
    } as JSONSchema7;
    expect(factorResponseSchema(input)).toBe(input);
    const small = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
    } as JSONSchema7;
    expect(factorResponseSchema(small)).toBe(small);
  });
});
