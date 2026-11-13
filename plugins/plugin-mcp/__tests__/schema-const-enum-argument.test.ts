import { actionToJsonSchema, ElizaError } from "@elizaos/core/protocol";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  convertJsonSchemaToActionParams,
  validateParamsAgainstSchema,
} from "../src/protocol-utils/schema-converter";

function roundtrip(property: Record<string, unknown>) {
  const input = { properties: { value: property }, required: ["value"] };
  const schema = actionToJsonSchema({
    name: "MCP_TEST",
    description: "test",
    parameters: convertJsonSchemaToActionParams(input),
  } as never);
  const validate = new Ajv2020({ strict: false }).compile(schema);
  return {
    schema: schema.properties.value,
    input,
    accepts: (value: unknown) => validate({ value }),
  };
}

function refuses(property: Record<string, unknown>, code: string) {
  expect(() => roundtrip(property)).toThrowError(expect.objectContaining({ code }));
  try {
    roundtrip(property);
  } catch (error) {
    expect(error).toBeInstanceOf(ElizaError);
  }
}

const UNSATISFIABLE = "MCP_PINNED_SCHEMA_UNSATISFIABLE";
const UNSUPPORTED = "MCP_PINNED_SCHEMA_UNSUPPORTED";

describe("exact pinned MCP argument schemas", () => {
  for (const value of ["fast", 1, false, null]) {
    it(`projects const ${JSON.stringify(value)} as a singleton enum`, () => {
      const result = roundtrip({ const: value });
      expect(result.schema.enum).toEqual([value]);
      expect(result.schema.type).toBe(value === null ? "null" : typeof value);
      expect(result.accepts(value)).toBe(true);
      expect(result.accepts("different")).toBe(false);
      expect(validateParamsAgainstSchema({ value }, result.input)).toEqual([]);
    });
  }

  it("retains every mixed primitive enum member through core", () => {
    const values = [null, 1, "x", false];
    const result = roundtrip({ enum: values });
    expect(result.schema.anyOf).toEqual([
      { type: "null", enum: [null] },
      { type: "number", enum: [1] },
      { type: "string", enum: ["x"] },
      { type: "boolean", enum: [false] },
    ]);
    for (const value of values) {
      expect(result.accepts(value)).toBe(true);
      expect(validateParamsAgainstSchema({ value }, result.input)).toEqual([]);
    }
    for (const value of [2, "other", true, {}, []]) {
      expect(result.accepts(value)).toBe(false);
      expect(validateParamsAgainstSchema({ value }, result.input).length).toBeGreaterThan(0);
    }
  });

  it("keeps numeric and boolean enum members uncoerced", () => {
    for (const values of [
      [1, 2, 3],
      [true, false],
    ]) {
      const result = roundtrip({ enum: values });
      expect(result.schema.enum).toEqual(values);
      for (const value of values) expect(result.accepts(value)).toBe(true);
      expect(result.accepts(String(values[0]))).toBe(false);
    }
  });

  it("roundtrips a 4,096-member primitive enum", () => {
    const values = Array.from({ length: 4096 }, (_, index) => index);
    const result = roundtrip({ enum: values });
    expect(result.schema.enum).toEqual(values);
    expect(result.accepts(0)).toBe(true);
    expect(result.accepts(4095)).toBe(true);
    expect(result.accepts(4096)).toBe(false);
    expect(validateParamsAgainstSchema({ value: 4095 }, result.input)).toEqual([]);
  });

  it("preserves a null-only enum", () => {
    const result = roundtrip({ enum: [null] });
    expect(result.schema).toMatchObject({ type: "null", enum: [null] });
    expect(result.accepts(null)).toBe(true);
    expect(result.accepts({})).toBe(false);
  });

  it("intersects const, enum, and declared union types", () => {
    const result = roundtrip({ const: "b", enum: [1, "a", "b"], anyOf: [{ type: "string" }] });
    expect(result.schema).toMatchObject({ type: "string", enum: ["b"] });
    expect(result.accepts("b")).toBe(true);
    for (const value of [1, "a"]) expect(result.accepts(value)).toBe(false);
  });

  it("retains only values that satisfy both anyOf and oneOf", () => {
    const result = roundtrip({
      enum: ["a", "b", "c"],
      anyOf: [{ enum: ["a", "b"] }],
      oneOf: [{ enum: ["a", "b"] }, { const: "b" }],
    });
    expect(result.schema.enum).toEqual(["a"]);
    expect(result.accepts("a")).toBe(true);
    expect(result.accepts("b")).toBe(false);
    expect(result.accepts("c")).toBe(false);
  });

  it("intersects finite allOf candidates", () => {
    const result = roundtrip({ allOf: [{ enum: [1, 2, 3] }, { enum: [2, 3] }, { const: 2 }] });
    expect(result.schema.enum).toEqual([2]);
    expect(result.accepts(2)).toBe(true);
    expect(result.accepts(1)).toBe(false);
  });

  it("removes overlapping finite oneOf candidates", () => {
    const result = roundtrip({ oneOf: [{ const: "a" }, { enum: ["a", "b"] }] });
    expect(result.schema.enum).toEqual(["b"]);
    expect(result.accepts("b")).toBe(true);
    expect(result.accepts("a")).toBe(false);
    expect(validateParamsAgainstSchema({ value: "a" }, result.input)).toEqual([
      "Parameter 'value' matches more than one branch of the oneOf",
    ]);
  });

  it("preserves per-kind enum sets from finite union branches", () => {
    const result = roundtrip({
      anyOf: [{ enum: ["x", "y"] }, { enum: [1, 2] }],
    });
    expect(result.schema.anyOf).toEqual([
      { type: "string", enum: ["x", "y"] },
      { type: "number", enum: [1, 2] },
    ]);
    for (const value of ["x", "y", 1, 2]) expect(result.accepts(value)).toBe(true);
    for (const value of ["z", 3]) expect(result.accepts(value)).toBe(false);
  });

  it("preserves nested mixed finite and open unions", () => {
    const result = roundtrip({
      anyOf: [{ type: "string" }, { oneOf: [{ const: 1 }, { type: "integer" }] }],
    });
    expect(result.accepts("x")).toBe(true);
    expect(result.accepts(2)).toBe(true);
    expect(result.accepts(1)).toBe(false);
    expect(result.accepts(1.5)).toBe(false);
  });

  it("counts only branches whose type and integer constraint match", () => {
    const typed = roundtrip({
      oneOf: [
        { type: "string", enum: ["a"] },
        { type: "number", enum: ["a"] },
      ],
    });
    expect(typed.schema.enum).toEqual(["a"]);
    const integer = roundtrip({ oneOf: [{ type: "integer", enum: [1, 1.5] }, { const: 1.5 }] });
    expect(integer.schema.enum).toEqual([1, 1.5]);
    expect(integer.accepts(1.5)).toBe(true);
  });

  it("does not widen a finite branch beside an open primitive branch", () => {
    const result = roundtrip({ anyOf: [{ const: 1 }, { type: "string" }] });
    expect(result.schema.anyOf).toEqual([{ type: "number", enum: [1] }, { type: "string" }]);
    expect(result.accepts(1)).toBe(true);
    expect(result.accepts("anything")).toBe(true);
    expect(result.accepts(2)).toBe(false);
    expect(validateParamsAgainstSchema({ value: 2 }, result.input).length).toBeGreaterThan(0);
  });

  it("preserves exclusion by an overlapping open oneOf branch", () => {
    const result = roundtrip({ oneOf: [{ const: "x" }, { type: "string" }] });
    expect(result.accepts("other")).toBe(true);
    expect(result.accepts("x")).toBe(false);
    expect(validateParamsAgainstSchema({ value: "x" }, result.input)).toEqual([
      "Parameter 'value' matches more than one branch of the oneOf",
    ]);
  });

  it("retains a sibling type on an open union", () => {
    const result = roundtrip({ type: "string", anyOf: [{ const: 1 }, { type: "string" }] });
    expect(result.accepts("anything")).toBe(true);
    expect(result.accepts(1)).toBe(false);
  });

  for (const property of [
    { const: "a", enum: ["b"] },
    { const: 1, type: "string" },
    { const: "a", anyOf: [{ const: "b" }] },
    { type: "string", anyOf: [{ const: 1 }] },
    { enum: [] },
    { oneOf: [{ const: null }, { type: "null" }] },
  ]) {
    it(`refuses impossible finite schema ${JSON.stringify(property)}`, () => {
      refuses(property, UNSATISFIABLE);
      expect(() =>
        validateParamsAgainstSchema({ value: null }, { properties: { value: property } })
      ).toThrowError(expect.objectContaining({ code: UNSATISFIABLE }));
    });
  }

  for (const property of [
    { const: { key: "value" } },
    { enum: [[1, 2]] },
    { anyOf: [{ const: "a" }, {}] },
    { enum: [1, 2], maximum: 1 },
    { type: "object", properties: { nested: { const: "a" } } },
    { anyOf: [{ const: "a" }, { type: "object" }] },
    { const: 1, allOf: [] },
    { const: 1, anyOf: [] },
    { const: 1, oneOf: [] },
    { const: 1, type: [] },
    { const: 1, type: ["number", "number"] },
    { const: 1, enum: "invalid" },
    { const: 1, anyOf: "invalid" },
  ]) {
    it(`refuses unsupported pinned schema ${JSON.stringify(property)}`, () => {
      refuses(property, UNSUPPORTED);
      expect(() =>
        validateParamsAgainstSchema(
          { value: null },
          {
            properties: { value: property },
            required: ["value"],
          }
        )
      ).toThrowError(expect.objectContaining({ code: UNSUPPORTED }));
    });
  }
});
