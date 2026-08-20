/**
 * JSON utility tests for MCP model-output parsing and argument validation.
 * They cover fenced/prose-wrapped JSON extraction, JSON5 leniency, and schema checks for tool-call arguments.
 */

import { ElizaError } from "@elizaos/core/errors";
import { describe, expect, it } from "vitest";
import {
  assertMcpJsonSchemaBudget,
  MCP_TOOL_SCHEMA_UNBOUNDED,
  parseJSON,
  parseStructuredModelOutput,
  validateJsonSchema,
} from "../json";

describe("parseJSON", () => {
  it("parses a plain JSON object", () => {
    expect(parseJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips a ```json markdown fence", () => {
    expect(parseJSON('```json\n{"a":1,"b":2}\n```')).toEqual({ a: 1, b: 2 });
  });

  it("extracts the object from surrounding prose (first { to last })", () => {
    expect(parseJSON('Sure, here it is: {"ok":true} — done')).toEqual({ ok: true });
  });

  it("accepts JSON5 leniency (unquoted keys, single quotes, trailing comma)", () => {
    expect(parseJSON("{ a: 1, b: 'two', }")).toEqual({ a: 1, b: "two" });
  });

  it("parses a nested object", () => {
    expect(parseJSON('{"a":{"b":2}}')).toEqual({ a: { b: 2 } });
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseJSON("no json here")).toThrow(/No valid JSON object/);
  });
});

describe("parseStructuredModelOutput", () => {
  it("returns the parsed object for valid (fenced) output", () => {
    expect(parseStructuredModelOutput('```\n{"x":42}\n```')).toEqual({ x: 42 });
  });
  it("throws a descriptive error when nothing parses", () => {
    expect(() => parseStructuredModelOutput("nope")).toThrow(/No valid JSON object found/);
  });
});

describe("validateJsonSchema", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  } as const;

  it("accepts data that satisfies the schema", () => {
    const result = validateJsonSchema<{ name: string }>({ name: "tool" }, schema);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("tool");
  });

  it("rejects data missing a required field, with an error message", () => {
    const result = validateJsonSchema({}, schema);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.length).toBeGreaterThan(0);
  });

  it("rejects a wrong-typed field", () => {
    const result = validateJsonSchema({ name: 123 }, schema);
    expect(result.success).toBe(false);
  });

  it("does not throw when an MCP tool inputSchema is the allOf $ref bomb", () => {
    const bomb = {
      $id: "http://evil/mcp-schema-bomb",
      type: "object",
      allOf: [{ $ref: "#" }, { $ref: "#" }],
    };
    const result = validateJsonSchema({}, bomb);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/schema validation failed:/);
    }
  });

  it("does not reject duplicate references to a finite schema", () => {
    const schemaWithSafeDuplicateRefs = {
      $defs: { leaf: { type: "string" } },
      allOf: [{ $ref: "#/$defs/leaf" }, { $ref: "#/$defs/leaf" }],
    };

    expect(validateJsonSchema("value", schemaWithSafeDuplicateRefs)).toEqual({
      success: true,
      data: "value",
    });
  });

  it("preserves a recursive tree schema", () => {
    const recursiveTree = {
      $defs: {
        node: {
          type: "object",
          properties: { child: { $ref: "#/$defs/node" } },
        },
      },
      $ref: "#/$defs/node",
    };

    expect(validateJsonSchema({ child: {} }, recursiveTree).success).toBe(true);
  });

  it("rejects an indirect recursive composition that bypasses duplicate-ref heuristics", () => {
    const indirectBomb = {
      $defs: { left: { $ref: "#" }, right: { $ref: "#" } },
      allOf: [{ $ref: "#/$defs/left" }, { $ref: "#/$defs/right" }],
    };

    const result = validateJsonSchema({}, indirectBomb);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/schema validation failed:/);
    }
  });

  it("rejects asynchronous schemas instead of treating a Promise as valid data", () => {
    const result = validateJsonSchema("wrong", { $async: true, type: "number" });
    expect(result).toEqual({
      success: false,
      error: "MCP JSON schema uses unsupported asynchronous validation",
    });
  });

  it("does not poison a process-wide Ajv cache when two schemas share $id", () => {
    const first = {
      $id: "http://example.com/shared-tool",
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const second = {
      $id: "http://example.com/shared-tool",
      type: "object",
      properties: { b: { type: "number" } },
      required: ["b"],
    };
    expect(validateJsonSchema({ a: "ok" }, first).success).toBe(true);
    const again = validateJsonSchema({ b: 1 }, second);
    expect(again.success).toBe(true);
  });

  it("rejects an oversized schema before compiling it", () => {
    const huge = { type: "string", description: "x".repeat(256 * 1024) };
    const result = validateJsonSchema("value", huge);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/serialized size/);
    }
  });

  it("rejects an excessively nested schema before compiling it", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 40; i++) {
      deep = { type: "object", properties: { child: deep } };
    }
    const result = validateJsonSchema({}, deep);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/nesting depth/);
    }
  });
});

describe("assertMcpJsonSchemaBudget", () => {
  it("accepts a small object schema", () => {
    expect(() =>
      assertMcpJsonSchemaBudget({
        type: "object",
        properties: { name: { type: "string" } },
      })
    ).not.toThrow();
  });

  it("throws MCP_TOOL_SCHEMA_UNBOUNDED on a cyclic graph", () => {
    const cyclic: Record<string, unknown> = { type: "array" };
    cyclic.items = cyclic;
    expect(() => assertMcpJsonSchemaBudget(cyclic)).toThrowError(ElizaError);
    try {
      assertMcpJsonSchemaBudget(cyclic);
    } catch (error) {
      expect((error as ElizaError).code).toBe(MCP_TOOL_SCHEMA_UNBOUNDED);
    }
  });

  it("rejects a huge sparse array before whole-graph serialization", () => {
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    expect(() => assertMcpJsonSchemaBudget(sparse)).toThrowError(ElizaError);
  });

  it("rejects giant primitive text during traversal", () => {
    expect(() =>
      assertMcpJsonSchemaBudget({ type: "string", description: "x".repeat(300_000) })
    ).toThrowError(/serialized size/);
  });

  it("rejects a throwing schema accessor as unsafe input", () => {
    const schema = { type: "object" } as Record<string, unknown>;
    Object.defineProperty(schema, "properties", {
      enumerable: true,
      get: () => {
        throw new Error("getter escaped");
      },
    });
    expect(() => assertMcpJsonSchemaBudget(schema)).toThrowError(/not safely traversable/);
  });
});
