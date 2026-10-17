import { describe, expect, it } from "vitest";
import {
  convertJsonSchemaToActionParams,
  validateParamsAgainstSchema,
} from "../src/protocol-utils/schema-converter";

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
    expect(
      validateParamsAgainstSchema({ limit: 2 }, { properties: { limit: { const: 1 } } })
    ).toEqual([]);
  });
});
