/**
 * MCP tool schema conversion. The output becomes model-facing parameter
 * descriptions, so the repository prompt-integrity rule applies: every property
 * and every constraint must render completely, with no cap or elision. Also
 * pins recursive lossless rendering of nested objects, arrays of objects,
 * item-count and numeric constraints (exclusiveMinimum, multipleOf), compositions,
 * $ref, and validation of nullable unions using both null and typed values.
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

describe("convertJsonSchemaToActionParams — recursive object rendering", () => {
  test("renders nested object properties with types, descriptions, and required markers", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        user: {
          type: "object",
          description: "User details",
          required: ["id", "profile"],
          properties: {
            id: { type: "string", format: "uuid", description: "Unique identifier" },
            email: { type: "string", format: "email" },
            profile: {
              type: "object",
              description: "Nested profile",
              required: ["displayName"],
              properties: {
                displayName: { type: "string", minLength: 1, maxLength: 50 },
                age: { type: "integer", minimum: 0, maximum: 150 },
              },
            },
          },
        },
      }),
    );
    const desc = params?.[0].description ?? "";
    expect(desc).toContain("User details");
    expect(desc).toContain("id (string, required): Unique identifier. Format: uuid");
    expect(desc).toContain("email (string, optional): Format: email");
    expect(desc).toContain("profile (object, required): Nested profile");
    expect(desc).toContain("displayName (string, required): Length: min: 1, max: 50");
    expect(desc).toContain("age (integer, optional): Range: min: 0, max: 150");
  });

  test("renders 4-level deep nested object hierarchy losslessly", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        root: {
          type: "object",
          properties: {
            l1: {
              type: "object",
              required: ["l2"],
              properties: {
                l2: {
                  type: "object",
                  required: ["l3"],
                  properties: {
                    l3: {
                      type: "object",
                      required: ["target"],
                      properties: {
                        target: {
                          type: "string",
                          description: "Deep leaf target",
                          pattern: "^leaf-[0-9]+$",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    const desc = params?.[0].description ?? "";
    expect(desc).toContain("l1 (object, optional)");
    expect(desc).toContain("l2 (object, required)");
    expect(desc).toContain("l3 (object, required)");
    expect(desc).toContain("target (string, required): Deep leaf target. Pattern: ^leaf-[0-9]+$");
  });

  test("renders object property constraints (minProperties, maxProperties, additionalProperties)", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        strictMap: {
          type: "object",
          minProperties: 2,
          maxProperties: 10,
          additionalProperties: false,
          properties: {
            key: { type: "string" },
          },
        },
        typedMap: {
          type: "object",
          additionalProperties: {
            type: "number",
            minimum: 0,
          },
        },
      }),
    );
    const desc0 = params?.[0].description ?? "";
    expect(desc0).toContain("Property count: min: 2, max: 10");
    expect(desc0).toContain("Additional properties: false");
    expect(desc0).toContain("key (string, optional)");

    const desc1 = params?.[1].description ?? "";
    expect(desc1).toContain("Additional properties: number (Range: min: 0)");
  });
});

describe("convertJsonSchemaToActionParams — array items and constraints", () => {
  test("renders array item counts and uniqueItems constraint", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 2,
            maxLength: 30,
            pattern: "^[a-z0-9_-]+$",
          },
        },
      }),
    );
    const desc = params?.[0].description ?? "";
    expect(desc).toContain("Item count: min: 1, max: 20");
    expect(desc).toContain("Unique items: true");
    expect(desc).toContain("Array of string (Length: min: 2, max: 30. Pattern: ^[a-z0-9_-]+$)");
  });

  test("renders array of objects with full nested constraints losslessly", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        orders: {
          type: "array",
          description: "List of pending orders",
          items: {
            type: "object",
            description: "Order entry",
            required: ["orderId", "amount"],
            properties: {
              orderId: { type: "string", format: "uuid" },
              amount: { type: "number", exclusiveMinimum: 0, multipleOf: 0.01 },
              status: { type: "string", enum: ["pending", "shipped", "delivered"] },
            },
          },
        },
      }),
    );
    const desc = params?.[0].description ?? "";
    expect(desc).toContain("List of pending orders");
    expect(desc).toContain("Array of object");
    expect(desc).toContain("Order entry");
    expect(desc).toContain("orderId (string, required): Format: uuid");
    expect(desc).toContain("amount (number, required): Range: exclusiveMin: 0. Multiple of: 0.01");
    expect(desc).toContain('status (string, optional): Allowed: "pending", "shipped", "delivered"');
  });

  test("renders tuple schemas and array contains constraint", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        coordinate: {
          type: "array",
          description: "GPS coordinate",
          items: [
            { type: "number", minimum: -90, maximum: 90 },
            { type: "number", minimum: -180, maximum: 180 },
          ],
        },
        hasAdmin: {
          type: "array",
          contains: {
            type: "string",
            enum: ["admin", "superuser"],
          },
        },
      }),
    );
    const desc0 = params?.[0].description ?? "";
    expect(desc0).toContain(
      "Tuple items: [number (Range: min: -90, max: 90), number (Range: min: -180, max: 180)]",
    );

    const desc1 = params?.[1].description ?? "";
    expect(desc1).toContain('Contains: string (Allowed: "admin", "superuser")');
  });
});

describe("convertJsonSchemaToActionParams — numeric constraints", () => {
  test("renders exclusiveMinimum, exclusiveMaximum, and multipleOf", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        exclusiveRange: {
          type: "number",
          exclusiveMinimum: 0,
          exclusiveMaximum: 100,
          multipleOf: 0.5,
        },
        mixedRange: {
          type: "number",
          minimum: 10,
          exclusiveMaximum: 20,
        },
        mixedRange2: {
          type: "number",
          exclusiveMinimum: 5,
          maximum: 15,
        },
      }),
    );
    const d0 = params?.[0].description ?? "";
    expect(d0).toContain("Range: exclusiveMin: 0, exclusiveMax: 100");
    expect(d0).toContain("Multiple of: 0.5");

    const d1 = params?.[1].description ?? "";
    expect(d1).toContain("Range: min: 10, exclusiveMax: 20");

    const d2 = params?.[2].description ?? "";
    expect(d2).toContain("Range: exclusiveMin: 5, max: 15");
  });

  test("renders boundary numeric values including 0", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        zeroBound: {
          type: "number",
          minimum: 0,
          exclusiveMaximum: 0,
        },
      }),
    );
    const d = params?.[0].description ?? "";
    expect(d).toContain("Range: min: 0, exclusiveMax: 0");
  });
});

describe("convertJsonSchemaToActionParams — compositions, $ref, and const", () => {
  test("renders $ref references losslessly", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        address: {
          $ref: "#/definitions/Address",
          description: "Shipping destination",
        },
      }),
    );
    const d = params?.[0].description ?? "";
    expect(d).toContain("Shipping destination");
    expect(d).toContain("$ref: #/definitions/Address");
  });

  test("renders oneOf, anyOf, and allOf compositions with variant descriptions", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        identifier: {
          description: "Flexible ID",
          oneOf: [
            { type: "string", format: "uuid" },
            { type: "integer", minimum: 1 },
          ],
        },
        multiFormat: {
          anyOf: [
            { type: "string", minLength: 1 },
            { type: "array", items: { type: "string" } },
          ],
        },
        intersection: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
      }),
    );
    const d0 = params?.[0].description ?? "";
    expect(d0).toContain("Flexible ID");
    expect(d0).toContain("One of: [string (Format: uuid) | integer (Range: min: 1)]");

    const d1 = params?.[1].description ?? "";
    expect(d1).toContain("Any of: [string (Length: min: 1) | array (Array of string)]");

    const d2 = params?.[2].description ?? "";
    expect(d2).toContain(
      "All of: [object (Properties: { a (string, optional) }) & object (Properties: { b (number, optional) })]",
    );
  });

  test("renders const constraint", () => {
    const params = convertJsonSchemaToActionParams(
      schema({
        kind: {
          const: "event.v1",
          description: "Event discriminator",
        },
      }),
    );
    const d = params?.[0].description ?? "";
    expect(d).toContain("Event discriminator");
    expect(d).toContain('Const: "event.v1"');
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
    const nullableSchema = schema({ a: { type: ["string", "null"] } });
    expect(validateParamsAgainstSchema({ a: "x" }, nullableSchema)).toEqual([]);
    expect(validateParamsAgainstSchema({ a: null }, nullableSchema)).toEqual([]);

    const nullableRequiredSchema = schema({ a: { type: ["string", "null"] } }, ["a"]);
    expect(validateParamsAgainstSchema({ a: null }, nullableRequiredSchema)).toEqual([]);
    expect(validateParamsAgainstSchema({ a: "valid" }, nullableRequiredSchema)).toEqual([]);
    expect(validateParamsAgainstSchema({ a: 123 }, nullableRequiredSchema)).toEqual([
      "Parameter 'a' expected string, got number",
    ]);
    expect(validateParamsAgainstSchema({ a: undefined }, nullableRequiredSchema)).toEqual([
      "Missing required parameter: a",
    ]);
    expect(validateParamsAgainstSchema({}, nullableRequiredSchema)).toEqual([
      "Missing required parameter: a",
    ]);
  });

  test("accepts null for OpenAPI-style nullable: true properties", () => {
    const openApiNullable = schema({ a: { type: "string", nullable: true } }, ["a"]);
    expect(validateParamsAgainstSchema({ a: null }, openApiNullable)).toEqual([]);
    expect(validateParamsAgainstSchema({ a: "hello" }, openApiNullable)).toEqual([]);
    expect(validateParamsAgainstSchema({ a: 999 }, openApiNullable)).toEqual([
      "Parameter 'a' expected string, got number",
    ]);
  });

  test("accepts any valid type for multi-type unions", () => {
    const multiType = schema({ a: { type: ["string", "number"] } });
    expect(validateParamsAgainstSchema({ a: "hello" }, multiType)).toEqual([]);
    expect(validateParamsAgainstSchema({ a: 42 }, multiType)).toEqual([]);
    expect(validateParamsAgainstSchema({ a: true }, multiType)).toEqual([
      "Parameter 'a' expected string, got boolean",
    ]);
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
