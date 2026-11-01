import { describe, expect, it } from "vitest";
import {
  convertJsonSchemaToActionParams,
  validateParamsAgainstSchema,
} from "../src/protocol-utils/schema-converter";

// pydantic emits `{"const": "fast"}` for a single-value Literal and may emit an
// `enum` with no `type`. Neither names a type, so both used to fall back to an
// object parameter that rejected the only legal values.
describe("const and enum tool arguments without a type", () => {
  it("declares the kind of the pinned values instead of object", () => {
    expect(
      convertJsonSchemaToActionParams({ properties: { mode: { const: "fast" } } })?.map(
        (param) => param.schema.type
      )
    ).toEqual(["string"]);
    expect(
      convertJsonSchemaToActionParams({ properties: { version: { const: 1 } } })?.map(
        (param) => param.schema.type
      )
    ).toEqual(["number"]);
    expect(
      convertJsonSchemaToActionParams({ properties: { level: { enum: [1, 2, 3] } } })?.map(
        (param) => param.schema.type
      )
    ).toEqual(["number"]);
  });

  it("declares a mixed-kind enum as a pure anyOf union", () => {
    const params = convertJsonSchemaToActionParams({
      properties: { limit: { enum: ["all", 3] } },
    });
    expect(params?.[0]?.schema.type).toBeUndefined();
    expect(params?.[0]?.schema.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
    expect(params?.[0]?.schema.enum).toBeUndefined();
  });

  it("accepts the const value and rejects every other value", () => {
    const schema = { properties: { mode: { const: "fast" } }, required: ["mode"] };
    expect(validateParamsAgainstSchema({ mode: "fast" }, schema)).toEqual([]);
    expect(validateParamsAgainstSchema({ mode: "slow" }, schema)).toEqual([
      "Parameter 'mode' must be \"fast\"",
    ]);
    expect(validateParamsAgainstSchema({ mode: {} }, schema)).toEqual([
      "Parameter 'mode' must be \"fast\"",
    ]);
  });

  it("accepts an enum member and rejects a non-member", () => {
    const schema = { properties: { level: { enum: [1, 2, 3] } } };
    expect(validateParamsAgainstSchema({ level: 2 }, schema)).toEqual([]);
    expect(validateParamsAgainstSchema({ level: 5 }, schema)).toEqual([
      "Parameter 'level' must be one of: 1, 2, 3",
    ]);
  });

  it("reads the kind and the pinned set from anyOf branches", () => {
    const constUnion = {
      properties: { mode: { anyOf: [{ const: "x" }, { type: "null" }] } },
    };
    expect(convertJsonSchemaToActionParams(constUnion)?.[0]?.schema.type).toBe("string");
    expect(validateParamsAgainstSchema({ mode: "x" }, constUnion)).toEqual([]);
    expect(validateParamsAgainstSchema({ mode: "y" }, constUnion)).toEqual([
      "Parameter 'mode' must be one of: \"x\", null",
    ]);

    // Optional[Literal["a", "b"]] as pydantic emits it: an enum branch + null.
    const optionalLiteral = {
      properties: { mode: { anyOf: [{ enum: ["a", "b"], type: "string" }, { type: "null" }] } },
    };
    expect(validateParamsAgainstSchema({ mode: "a" }, optionalLiteral)).toEqual([]);
    expect(validateParamsAgainstSchema({ mode: null }, optionalLiteral)).toEqual([]);
    expect(validateParamsAgainstSchema({ mode: "c" }, optionalLiteral)).toEqual([
      'Parameter \'mode\' must be one of: "a", "b", null',
    ]);
  });

  it("keeps a union with an open branch open", () => {
    const openUnion = {
      properties: { mode: { anyOf: [{ const: "x" }, { type: "string" }] } },
    };
    expect(validateParamsAgainstSchema({ mode: "anything" }, openUnion)).toEqual([]);
  });
});
