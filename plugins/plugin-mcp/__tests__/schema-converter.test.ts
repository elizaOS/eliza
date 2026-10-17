import { describe, expect, it } from "vitest";
import { validateParamsAgainstSchema } from "../src/protocol-utils/schema-converter";

describe("validateParamsAgainstSchema null handling", () => {
  it("combines type with enum and const when deciding nullability", () => {
    expect(
      validateParamsAgainstSchema(
        { mode: null },
        { properties: { mode: { enum: [null, "automatic"] } } }
      )
    ).toEqual([]);
    expect(
      validateParamsAgainstSchema({ mode: null }, { properties: { mode: { const: null } } })
    ).toEqual([]);
    expect(
      validateParamsAgainstSchema(
        { mode: null },
        { properties: { mode: { type: "string", enum: [null, "automatic"] } } }
      )
    ).toEqual(["Parameter 'mode' does not accept null"]);
    expect(
      validateParamsAgainstSchema(
        { mode: null },
        { properties: { mode: { type: "string", const: null } } }
      )
    ).toEqual(["Parameter 'mode' does not accept null"]);
    expect(
      validateParamsAgainstSchema(
        { mode: null },
        { properties: { mode: { type: "string", nullable: true, enum: ["automatic"] } } }
      )
    ).toEqual(["Parameter 'mode' does not accept null"]);
  });

  it("accepts empty schemas and required nullable schemas", () => {
    expect(validateParamsAgainstSchema({ mode: null }, { properties: { mode: {} } })).toEqual([]);
    expect(
      validateParamsAgainstSchema(
        { mode: null },
        {
          properties: { mode: { type: ["string", "null"] } },
          required: ["mode"],
        }
      )
    ).toEqual([]);
  });

  it("rejects an optional null that the schema does not allow", () => {
    expect(
      validateParamsAgainstSchema({ mode: null }, { properties: { mode: { type: "string" } } })
    ).toEqual(["Parameter 'mode' does not accept null"]);
  });
});

describe("validateParamsAgainstSchema type derivation without top-level type", () => {
  it("accepts a string value for an anyOf schema with no top-level type", () => {
    expect(
      validateParamsAgainstSchema(
        { mode: "hello" },
        { properties: { mode: { anyOf: [{ type: "string" }, { type: "number" }] } } },
      ),
    ).toEqual([]);
  });

  it("accepts a number value for an anyOf schema with no top-level type", () => {
    expect(
      validateParamsAgainstSchema(
        { mode: 42 },
        { properties: { mode: { anyOf: [{ type: "string" }, { type: "number" }] } } },
      ),
    ).toEqual([]);
  });

  it("rejects a value whose type is not in anyOf branches", () => {
    expect(
      validateParamsAgainstSchema(
        { mode: true },
        { properties: { mode: { anyOf: [{ type: "string" }, { type: "number" }] } } },
      ),
    ).toEqual(["Parameter 'mode' expected string | number, got boolean"]);
  });

  it("accepts a string value for a oneOf schema with no top-level type", () => {
    expect(
      validateParamsAgainstSchema(
        { mode: "hello" },
        { properties: { mode: { oneOf: [{ type: "string" }, { type: "boolean" }] } } },
      ),
    ).toEqual([]);
  });

  it("accepts a string value for an enum schema with no top-level type", () => {
    expect(
      validateParamsAgainstSchema(
        { mode: "automatic" },
        { properties: { mode: { enum: ["automatic", "manual"] } } },
      ),
    ).toEqual([]);
  });

  it("accepts a number value for a mixed-type enum with no top-level type", () => {
    expect(
      validateParamsAgainstSchema(
        { mode: 5 },
        { properties: { mode: { enum: ["automatic", 5, true] } } },
      ),
    ).toEqual([]);
  });

  it("accepts a matching value for a const schema with no top-level type", () => {
    expect(
      validateParamsAgainstSchema(
        { mode: "hello" },
        { properties: { mode: { const: "hello" } } },
      ),
    ).toEqual([]);
  });

  it("accepts any value for an empty schema", () => {
    expect(
      validateParamsAgainstSchema({ mode: "anything" }, { properties: { mode: {} } }),
    ).toEqual([]);
    expect(
      validateParamsAgainstSchema({ mode: 123 }, { properties: { mode: {} } }),
    ).toEqual([]);
  });

  it("still rejects a non-enum string when type and enum are both present", () => {
    expect(
      validateParamsAgainstSchema(
        { mode: "invalid" },
        { properties: { mode: { type: "string", enum: ["automatic", "manual"] } } },
      ),
    ).toEqual(["Parameter 'mode' must be one of: \"automatic\", \"manual\""]);
  });
});
