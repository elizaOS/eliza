import { describe, expect, it } from "vitest";
// The provider-schema builder is not part of the public core entry point; the
// generated provider schema is what this regression has to observe.
import { actionParametersToJsonSchema } from "../../../packages/core/src/actions/action-schema";
import {
  convertJsonSchemaToActionParams,
  validateParamsAgainstSchema,
} from "../src/protocol-utils/schema-converter";

/** The provider schema the model actually receives for one MCP tool property. */
function providerProperty(inputSchema: {
  properties?: Record<string, unknown>;
  required?: string[];
}) {
  const parameters = convertJsonSchemaToActionParams(inputSchema);
  const jsonSchema = actionParametersToJsonSchema(
    parameters as unknown as Parameters<typeof actionParametersToJsonSchema>[0]
  );
  return jsonSchema.properties as Record<
    string,
    { type?: string; anyOf?: Array<{ type?: string }>; description?: string }
  >;
}

/**
 * An MCP tool property does not need a top-level `type`. pydantic and FastMCP
 * emit branch-only shapes for `Optional[str]` and `Literal[...]`, and those
 * branches decide which values the MCP server accepts.
 */
describe("tool arguments declared without a top-level type", () => {
  const optionalText = {
    type: "object",
    properties: { query: { anyOf: [{ type: "string" }, { type: "null" }] } },
    required: ["query"],
  };

  it("declares an anyOf argument with its branch type", () => {
    expect(convertJsonSchemaToActionParams(optionalText)?.[0].schema.type).toBe("string");
  });

  it("accepts a value that a branch allows", () => {
    expect(validateParamsAgainstSchema({ query: "quarterly report" }, optionalText)).toEqual([]);
  });

  it("still rejects a value that no branch allows", () => {
    expect(validateParamsAgainstSchema({ query: { text: "x" } }, optionalText)).toEqual([
      "Parameter 'query' expected string, got object",
    ]);
  });

  it("infers the kind of a const or enum argument", () => {
    expect(
      convertJsonSchemaToActionParams({
        properties: { mode: { enum: ["fast", "slow"] } },
      })?.[0].schema.type
    ).toBe("string");
    expect(
      convertJsonSchemaToActionParams({ properties: { limit: { const: 1 } } })?.[0].schema.type
    ).toBe("number");
  });

  it("rejects a value that is not the const value", () => {
    const schema = { properties: { limit: { const: 1 } } };
    expect(validateParamsAgainstSchema({ limit: 2 }, schema)).toEqual([
      "Parameter 'limit' must equal 1",
    ]);
    expect(validateParamsAgainstSchema({ limit: 1 }, schema)).toEqual([]);
  });

  it("rejects a value no const branch allows", () => {
    const schema = {
      properties: {
        mode: { anyOf: [{ const: "fast" }, { const: "slow" }] },
      },
    };
    expect(validateParamsAgainstSchema({ mode: "warp" }, schema)).toEqual([
      'Parameter \'mode\' must equal "fast" or "slow"',
    ]);
    expect(validateParamsAgainstSchema({ mode: "slow" }, schema)).toEqual([]);
    // One open branch leaves the whole union open, so a free string is allowed.
    expect(
      validateParamsAgainstSchema(
        { mode: "warp" },
        { properties: { mode: { anyOf: [{ const: "fast" }, { type: "string" }] } } }
      )
    ).toEqual([]);
  });
});

describe("an anyOf property with distinct branch types", () => {
  const stringOrNumber = {
    properties: {
      value: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
  };
  const numberOrString = {
    properties: {
      value: { anyOf: [{ type: "number" }, { type: "string" }] },
    },
  };

  it("advertises both branches instead of the first one", () => {
    expect(providerProperty(stringOrNumber).value.type).toBeUndefined();
    expect(
      providerProperty(stringOrNumber)
        .value.anyOf?.map((branch) => branch.type)
        .sort()
    ).toEqual(["number", "string"]);
  });

  it("declares no single type in either branch order", () => {
    for (const schema of [stringOrNumber, numberOrString]) {
      const property = providerProperty(schema).value;
      expect(property.type).toBeUndefined();
      expect(property.anyOf?.map((branch) => branch.type).sort()).toEqual(["number", "string"]);
    }
  });

  it("accepts a value from either branch", () => {
    expect(validateParamsAgainstSchema({ value: "text" }, stringOrNumber)).toEqual([]);
    expect(validateParamsAgainstSchema({ value: 2 }, stringOrNumber)).toEqual([]);
    expect(validateParamsAgainstSchema({ value: "text" }, numberOrString)).toEqual([]);
    expect(validateParamsAgainstSchema({ value: 2 }, numberOrString)).toEqual([]);
  });

  it("names both branch types when it rejects a value from neither branch", () => {
    expect(validateParamsAgainstSchema({ value: true }, stringOrNumber)).toEqual([
      "Parameter 'value' expected string | number, got boolean",
    ]);
  });

  it("keeps the single type when every branch normalizes to one runtime type", () => {
    expect(
      providerProperty({
        properties: { count: { anyOf: [{ type: "integer" }, { type: "number" }] } },
      }).count
    ).toMatchObject({ type: "number" });
    expect(
      providerProperty({
        properties: { query: { anyOf: [{ type: "string" }, { type: "null" }] } },
      }).query
    ).toMatchObject({ type: "string" });
  });
});
