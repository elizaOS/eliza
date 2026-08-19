/**
 * Deterministic tests for the MCP JSON Schema compile budget. Harness is local
 * and dependency-free: the walker rejects the Ajv allOf/$ref bomb and admits
 * ordinary tool schemas, including a single recursive $ref for tree data.
 */

import { describe, expect, it } from "vitest";
import {
  assertMcpJsonSchemaBudget,
  MAX_MCP_SCHEMA_DEPTH,
  MAX_MCP_SCHEMA_JSON_BYTES,
  McpSchemaTooComplexError,
} from "../mcp-schema-budget";

const ALLOF_REF_BOMB = {
  $id: "http://evil/mcp-schema-bomb",
  type: "object",
  allOf: [{ $ref: "#" }, { $ref: "#" }],
} as const;

describe("assertMcpJsonSchemaBudget", () => {
  it("admits a typical MCP tool object schema", () => {
    expect(() =>
      assertMcpJsonSchemaBudget({
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      })
    ).not.toThrow();
  });

  it("admits a single recursive $ref used as a tree node", () => {
    expect(() =>
      assertMcpJsonSchemaBudget({
        $defs: {
          node: {
            type: "object",
            properties: { child: { $ref: "#/$defs/node" } },
          },
        },
        $ref: "#/$defs/node",
      })
    ).not.toThrow();
  });

  it("rejects a 75-byte allOf of two $ref: '#' documents", () => {
    expect(() => assertMcpJsonSchemaBudget(ALLOF_REF_BOMB)).toThrow(McpSchemaTooComplexError);
    expect(() => assertMcpJsonSchemaBudget(ALLOF_REF_BOMB)).toThrow(/two \$refs to #/);
    expect(Buffer.byteLength(JSON.stringify(ALLOF_REF_BOMB))).toBeLessThan(120);
  });

  it("rejects definitions that allOf-ref themselves twice", () => {
    expect(() =>
      assertMcpJsonSchemaBudget({
        definitions: {
          a: {
            allOf: [{ $ref: "#/definitions/a" }, { $ref: "#/definitions/a" }],
          },
        },
        $ref: "#/definitions/a",
      })
    ).toThrow(/two \$refs to #\/definitions\/a/);
  });

  it("rejects a serialized schema larger than the byte budget", () => {
    const huge = { type: "string", description: "x".repeat(MAX_MCP_SCHEMA_JSON_BYTES) };
    expect(() => assertMcpJsonSchemaBudget(huge)).toThrow(/serialized size/);
  });

  it("rejects nesting deeper than the depth budget", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < MAX_MCP_SCHEMA_DEPTH + 4; i++) {
      schema = { type: "object", properties: { n: schema } };
    }
    expect(() => assertMcpJsonSchemaBudget(schema)).toThrow(/nesting depth/);
  });
});
