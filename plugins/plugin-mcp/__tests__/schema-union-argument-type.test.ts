import { describe, expect, it } from "vitest";
import {
  convertJsonSchemaToActionParams,
  validateParamsAgainstSchema,
} from "../src/protocol-utils/schema-converter";

// FastMCP emits this shape for `Optional[str]` and `Union[str, int]`.
const schema = {
  properties: {
    city: { anyOf: [{ type: "string" }, { type: "null" }] },
    id: { anyOf: [{ type: "string" }, { type: "integer" }] },
  },
};

describe("anyOf tool argument types", () => {
  it("declares the branch types instead of object", () => {
    const params = convertJsonSchemaToActionParams(schema);
    expect(params?.map((param) => param.schema.type ?? param.schema.anyOf)).toEqual([
      "string",
      [{ type: "string" }, { type: "number" }],
    ]);
  });

  it("accepts a value that matches a branch", () => {
    expect(validateParamsAgainstSchema({ city: "Paris", id: 7 }, schema)).toEqual([]);
    expect(validateParamsAgainstSchema({ city: 3 }, schema)).toEqual([
      "Parameter 'city' expected string, got number",
    ]);
  });
});
