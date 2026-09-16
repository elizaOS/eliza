/**
 * Exercises the canonical MCP schema walker with provider policy stubs,
 * including nullable unions and malformed untrusted type declarations.
 */
import { describe, expect, it } from "vitest";
import {
  type McpSchemaCompatibilityPolicy,
  transformMcpToolSchema,
} from "../tool-schema-compatibility.js";

const policy: McpSchemaCompatibilityPolicy = {
  applies: true,
  unsupportedFor: (type) => {
    switch (type) {
      case "string":
        return ["format", "pattern"];
      case "number":
      case "integer":
        return ["minimum", "maximum"];
      case "array":
        return ["minItems", "maxItems"];
      case "object":
        return ["minProperties", "additionalProperties"];
      default:
        return [];
    }
  },
  describe: (original, constraints) =>
    `${original ? `${original}\n` : ""}${JSON.stringify(constraints)}`,
};

describe("transformMcpToolSchema union types", () => {
  it("applies every concrete nullable type policy and recurses into children", () => {
    const transformed: Record<string, unknown> = transformMcpToolSchema(
      {
        type: ["null", "object"],
        minProperties: 1,
        additionalProperties: false,
        properties: {
          handle: {
            type: ["string", "null"],
            format: "email",
            pattern: "@",
          },
        },
      },
      policy,
    );

    expect(transformed.type).toEqual(["null", "object"]);
    expect(transformed).not.toHaveProperty("minProperties");
    expect(transformed).not.toHaveProperty("additionalProperties");
    expect(transformed.description).toBe(
      '{"minProperties":1,"additionalProperties":false}',
    );
    expect(transformed.properties).toEqual({
      handle: {
        type: ["string", "null"],
        description: '{"pattern":"@","format":"email"}',
      },
    });
  });

  it("evaluates equivalent type sets deterministically without rewriting wire order", () => {
    const first: Record<string, unknown> = transformMcpToolSchema(
      { type: ["integer", "string"], pattern: "x", minimum: 2 },
      policy,
    );
    const second: Record<string, unknown> = transformMcpToolSchema(
      { type: ["string", "integer"], pattern: "x", minimum: 2 },
      policy,
    );

    expect(first.type).toEqual(["integer", "string"]);
    expect(second.type).toEqual(["string", "integer"]);
    expect(first.description).toBe(second.description);
    expect(first).not.toHaveProperty("pattern");
    expect(first).not.toHaveProperty("minimum");
  });

  it("ignores invalid and unsupported type members while still traversing valid children", () => {
    const transformed: Record<string, unknown> = transformMcpToolSchema(
      {
        type: [null, 7, { invalid: true }],
        format: "root-is-not-a-string-schema",
        properties: {
          nested: { type: ["unknown", "string"], format: "uri" },
        },
      },
      policy,
    );

    expect(transformed.format).toBe("root-is-not-a-string-schema");
    expect(transformed.properties).toEqual({
      nested: {
        type: ["unknown", "string"],
        description: '{"format":"uri"}',
      },
    });
  });
});
