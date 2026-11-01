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

  it("enforces a top-level const that also names a type", () => {
    // `const` is a simultaneous constraint, not an alternative to `type`:
    // {"type": "string", "const": "fast"} admits "fast" alone.
    const schema = { properties: { mode: { type: "string", const: "fast" } } };
    expect(validateParamsAgainstSchema({ mode: "fast" }, schema)).toEqual([]);
    expect(validateParamsAgainstSchema({ mode: "slow" }, schema)).toEqual([
      "Parameter 'mode' must be \"fast\"",
    ]);
  });

  it("requires a oneOf value to be pinned by exactly one branch", () => {
    const overlap = {
      properties: { mode: { oneOf: [{ const: "a" }, { enum: ["a", "b"] }] } },
    };
    expect(validateParamsAgainstSchema({ mode: "b" }, overlap)).toEqual([]);
    expect(validateParamsAgainstSchema({ mode: "a" }, overlap)).toEqual([
      "Parameter 'mode' matches more than one branch of the oneOf",
    ]);
    expect(validateParamsAgainstSchema({ mode: "c" }, overlap)).toEqual([
      'Parameter \'mode\' must be one of: "a", "b"',
    ]);
  });

  it("declares both kinds of a union that mixes a typed and a pinned branch", () => {
    // The pinned branch names no type, so its kind comes from its value; the
    // union declares both kinds and validation accepts both branches' values.
    const mixed = { properties: { v: { anyOf: [{ type: "integer" }, { const: "x" }] } } };
    const schema = convertJsonSchemaToActionParams(mixed)?.[0]?.schema;
    expect(schema?.type).toBeUndefined();
    expect(schema?.anyOf).toEqual([{ type: "number" }, { type: "string" }]);
    expect(validateParamsAgainstSchema({ v: 5 }, mixed)).toEqual([]);
    expect(validateParamsAgainstSchema({ v: "x" }, mixed)).toEqual([]);
    expect(validateParamsAgainstSchema({ v: true }, mixed)).toEqual([
      "Parameter 'v' expected number | string, got boolean",
    ]);
  });
});
