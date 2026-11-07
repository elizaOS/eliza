import { describe, expect, it } from "vitest";
import { validateParamsAgainstSchema } from "../src/protocol-utils/schema-converter";

describe("oneOf null exactly-one semantics", () => {
  const run = (mode: unknown) =>
    validateParamsAgainstSchema({ mode: null }, { properties: { mode } });

  it("exactly one nullable branch accepts null", () => {
    expect(run({ oneOf: [{ type: "null" }, { type: "number" }] })).toEqual([]);
  });
  it("two nullable branches make null ambiguous -> rejected", () => {
    expect(run({ oneOf: [{}, {}] })).toContain("Parameter 'mode' does not accept null");
  });
  it("no nullable branch rejects null", () => {
    expect(run({ oneOf: [{ type: "string" }, { type: "number" }] })).toContain(
      "Parameter 'mode' does not accept null"
    );
  });
});
