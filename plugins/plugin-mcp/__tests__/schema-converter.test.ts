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
