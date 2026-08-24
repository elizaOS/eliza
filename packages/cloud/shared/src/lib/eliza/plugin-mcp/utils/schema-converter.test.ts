/**
 * MCP tool schema conversion. The output becomes model-facing parameter
 * descriptions, so the repository prompt-integrity rule applies: every property
 * and every constraint must render completely, with no cap or elision. Also
 * pins the validation contract — required fields, type mismatches, and enum
 * membership — including that a nullable union resolves to its non-null member.
 * Pure module, no harness.
 */

import { describe, expect, test } from "bun:test";
import { convertJsonSchemaToActionParams, validateParamsAgainstSchema } from "./schema-converter";

type Schema = Parameters<typeof convertJsonSchemaToActionParams>[0];

const schema = (properties: Record<string, unknown>, required?: string[]) =>
  ({ type: "object", properties, ...(required ? { required } : {}) }) as unknown as Schema;

describe("convertJsonSchemaToActionParams — empty input", () => {
  test("returns undefined for a missing or empty schema", () => {
    expect(convertJsonSchemaToActionParams(undefined)).toBeUndefined();
    expect(convertJsonSchemaToActionParams(schema({}))).toBeUndefined();
    expect(
      convertJsonSchemaToActionParams({ type: "object" } as unknown as Schema),
    ).toBeUndefined();
  });
});

describe("convertJsonSchemaToActionParams — type mapping", () => {
  test("maps each JSON Schema type to its action type", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        s: { type: "string" },
        n: { type: "number" },
        i: { type: "integer" },
        b: { type: "boolean" },
        a: { type: "array" },
        o: { type: "object" },
      }),
    );
    const byName = Object.fromEntries((params ?? []).map((p) => [p.name, p.schema.type]));
    expect(byName).toEqual({
      s: "string",
      n: "number",
      i: "number",
      b: "boolean",
      a: "array",
      o: "object",
    });
  });

  test("falls back to object for an unknown or missing type", () => {
    const params = convertJsonSchemaToActionParams(schema({ x: { type: "weird" }, y: {} }));
    for (const p of params ?? []) expect(p.schema.type).toBe("object");
  });

  test("resolves a nullable union to its non-null member", () => {
    const params = convertJsonSchemaToActionParams(
      schema({ a: { type: ["string", "null"] }, b: { type: ["null", "number"] } }),
    );
    const byName = Object.fromEntries((params ?? []).map((p) => [p.name, p.schema.type]));
    expect(byName).toEqual({ a: "string", b: "number" });
  });

  test("a null-only union degrades to object rather than crashing", () => {
    const params = convertJsonSchemaToActionParams(schema({ a: { type: ["null"] } }));
    expect(params?.[0].schema.type).toBe("object");
  });
});

describe("convertJsonSchemaToActionParams — required and defaults", () => {
  test("marks exactly the listed fields required", () => {
    const params = convertJsonSchemaToActionParams(
      schema({ a: { type: "string" }, b: { type: "string" } }, ["a"]),
    );
    const byName = Object.fromEntries((params ?? []).map((p) => [p.name, p.required]));
    expect(byName).toEqual({ a: true, b: false });
  });

  test("treats a missing required list as nothing required", () => {
    const params = convertJsonSchemaToActionParams(schema({ a: { type: "string" } }));
    expect(params?.[0].required).toBe(false);
  });

  test("passes a default through without coercion", () => {
    const params = convertJsonSchemaToActionParams(
      schema({ a: { type: "number", default: 0 }, b: { type: "boolean", default: false } }),
    );
    const byName = Object.fromEntries((params ?? []).map((p) => [p.name, p.schema.default]));
    expect(byName.a).toBe(0);
    expect(byName.b).toBe(false);
  });
});

describe("convertJsonSchemaToActionParams — prompt integrity", () => {
  test("converts every property, with no cap", () => {
    const many = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`p${i}`, { type: "string", description: `d${i}` }]),
    );
    const params = convertJsonSchemaToActionParams(schema(many));
    expect(params?.length).toBe(300);
    expect(params?.some((p) => p.name === "p299")).toBe(true);
  });

  test("carries a long description through complete", () => {
    const long = "x".repeat(50_000);
    const params = convertJsonSchemaToActionParams(
      schema({ a: { type: "string", description: long } }),
    );
    expect(params?.[0].description).toContain(long);
    expect(params?.[0].description).not.toContain("…");
    expect(params?.[0].description).not.toMatch(/truncat/i);
  });

  test("renders every declared constraint into the description", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        a: {
          type: "string",
          description: "The thing",
          enum: ["x", "y"],
          format: "uuid",
          minLength: 1,
          maxLength: 9,
          pattern: "^[a-z]+$",
          default: "x",
        },
      }),
    );
    const d = params?.[0].description ?? "";
    for (const fragment of [
      "The thing",
      'Allowed: "x", "y"',
      "Format: uuid",
      "Length: min: 1, max: 9",
      "Pattern: ^[a-z]+$",
      'Default: "x"',
    ]) {
      expect(d).toContain(fragment);
    }
  });

  test("renders a numeric range from either bound alone", () => {
    const params = convertJsonSchemaToActionParams(
      schema({ a: { type: "number", minimum: 0 }, b: { type: "number", maximum: 10 } }),
    );
    expect(params?.[0].description).toContain("Range: min: 0");
    expect(params?.[1].description).toContain("Range: max: 10");
  });

  test("lists every key of a nested object, not a sample", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`k${i}`, { type: "string" }]),
    );
    const params = convertJsonSchemaToActionParams(schema({ a: { type: "object", properties } }));
    const d = params?.[0].description ?? "";
    for (const key of ["k0", "k20", "k39"]) expect(d).toContain(key);
  });

  test("falls back to a type hint when nothing else is known", () => {
    const params = convertJsonSchemaToActionParams(schema({ a: { type: "string" } }));
    expect(params?.[0].description).toBe("(string)");
  });

  test("mirrors enum into both enum and enumValues as strings", () => {
    const params = convertJsonSchemaToActionParams(
      schema({ a: { type: "string", enum: ["x", 2, true] } }),
    );
    expect(params?.[0].schema.enum).toEqual(["x", "2", "true"]);
    expect(params?.[0].schema.enumValues).toEqual(["x", "2", "true"]);
  });
});

describe("validateParamsAgainstSchema — required", () => {
  test("returns no errors without a schema", () => {
    expect(validateParamsAgainstSchema({ a: 1 }, undefined)).toEqual([]);
  });

  test("flags a missing required field", () => {
    const errors = validateParamsAgainstSchema({}, schema({ a: { type: "string" } }, ["a"]));
    expect(errors).toEqual(["Missing required parameter: a"]);
  });

  test("treats explicit null and undefined as missing", () => {
    for (const value of [null, undefined]) {
      const errors = validateParamsAgainstSchema(
        { a: value },
        schema({ a: { type: "string" } }, ["a"]),
      );
      expect(errors).toContain("Missing required parameter: a");
    }
  });

  test("accepts falsy-but-present values for a required field", () => {
    for (const value of [0, "", false]) {
      const errors = validateParamsAgainstSchema(
        { a: value },
        schema({ a: { type: typeof value === "string" ? "string" : typeof value } }, ["a"]),
      );
      expect(errors).toEqual([]);
    }
  });

  test("reports every missing field, not just the first", () => {
    const errors = validateParamsAgainstSchema(
      {},
      schema({ a: { type: "string" }, b: { type: "string" } }, ["a", "b"]),
    );
    expect(errors.length).toBe(2);
  });
});

describe("validateParamsAgainstSchema — types and enums", () => {
  test("flags a type mismatch", () => {
    const errors = validateParamsAgainstSchema({ a: "x" }, schema({ a: { type: "number" } }));
    expect(errors).toEqual(["Parameter 'a' expected number, got string"]);
  });

  test("accepts a matching type", () => {
    for (const [value, type] of [
      ["x", "string"],
      [1, "number"],
      [true, "boolean"],
      [[1], "array"],
      [{}, "object"],
    ] as Array<[unknown, string]>) {
      expect(validateParamsAgainstSchema({ a: value }, schema({ a: { type } }))).toEqual([]);
    }
  });

  test("accepts an integer value for an integer schema", () => {
    expect(validateParamsAgainstSchema({ a: 3 }, schema({ a: { type: "integer" } }))).toEqual([]);
  });

  test("accepts a value matching either arm of a nullable union", () => {
    expect(
      validateParamsAgainstSchema({ a: "x" }, schema({ a: { type: ["string", "null"] } })),
    ).toEqual([]);
  });

  test("ignores parameters the schema does not declare", () => {
    expect(validateParamsAgainstSchema({ extra: 1 }, schema({ a: { type: "string" } }))).toEqual(
      [],
    );
  });

  test("flags a value outside the enum", () => {
    const errors = validateParamsAgainstSchema(
      { a: "z" },
      schema({ a: { type: "string", enum: ["x", "y"] } }),
    );
    expect(errors).toEqual([`Parameter 'a' must be one of: "x", "y"`]);
  });

  test("accepts a value inside the enum", () => {
    expect(
      validateParamsAgainstSchema({ a: "x" }, schema({ a: { type: "string", enum: ["x", "y"] } })),
    ).toEqual([]);
  });

  test("enum membership is strict — a string does not satisfy a numeric enum", () => {
    const errors = validateParamsAgainstSchema(
      { a: "1" },
      schema({ a: { type: "number", enum: [1, 2] } }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("reports every problem across every parameter", () => {
    const errors = validateParamsAgainstSchema(
      { a: 1, b: "z" },
      schema({ a: { type: "string" }, b: { type: "string", enum: ["x"] } }, ["c"]),
    );
    expect(errors.length).toBe(3);
  });
});
