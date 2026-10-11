import { describe, expect, it } from "vitest";
import { validateToolSelectionArgument } from "../validation";

const select = (toolArguments: unknown, schema: Record<string, unknown>) =>
  validateToolSelectionArgument(
    { serverName: "s", toolName: "t", toolArguments, reasoning: "r" },
    schema
  );

const discriminated = {
  type: "object",
  properties: {
    shape: {
      oneOf: [
        { type: "object", properties: { kind: { const: "a" } }, required: ["kind"] },
        { type: "object", properties: { kind: { const: "b" } }, required: ["kind"] },
      ],
      discriminator: { propertyName: "kind" },
    },
  },
};
const vendorKeyed = {
  type: "object",
  properties: { q: { type: "string", "x-order": 1, minLength: 3 } },
};

describe("MCP tool schemas with keywords Ajv does not know", () => {
  it("accepts valid arguments for a discriminator or x-* schema", async () => {
    expect((await select({ shape: { kind: "a" } }, discriminated)).success).toBe(true);
    expect((await select({ q: "abc" }, vendorKeyed)).success).toBe(true);
  });

  it("still enforces the known keywords", async () => {
    expect((await select({ shape: { kind: "z" } }, discriminated)).success).toBe(false);
    expect((await select({ q: "a" }, vendorKeyed)).success).toBe(false);
  });
});
