/**
 * Regression coverage for provider-specific MCP schema transformations using
 * deterministic JSON Schema inputs and no external MCP server.
 *
 * Also covers the fail-closed budget on attacker-controlled tool inputSchema
 * graphs: cyclic `items` used to RangeError `processSchema`.
 */
import { ElizaError } from "@elizaos/core/errors";
import { describe, expect, it } from "vitest";
import { GoogleMcpCompatibility } from "../src/tool-compatibility/providers/google.ts";
import { OpenAIMcpCompatibility } from "../src/tool-compatibility/providers/openai.ts";
import {
  MAX_MCP_SCHEMA_DEPTH,
  MAX_MCP_SCHEMA_NODES,
  MCP_TOOL_SCHEMA_UNBOUNDED,
} from "../src/utils/schema-budget.ts";

describe("MCP tool compatibility", () => {
  it("preserves zero upper bounds in Google descriptions", () => {
    const compatibility = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-pro",
    });

    // minLength/minItems are set alongside the zero upper bound so a
    // fallback path that only fires when every constraint is skipped
    // can't mask a truthy-check regression on maxLength/maxItems.
    const transformed = compatibility.transformToolSchema({
      type: "object",
      properties: {
        boundedText: { type: "string", minLength: 1, maxLength: 0 },
        boundedList: {
          type: "array",
          minItems: 1,
          maxItems: 0,
          items: { type: "string" },
        },
      },
    });

    expect(transformed.properties?.boundedText).toMatchObject({
      type: "string",
      description: expect.stringContaining("0"),
    });
    expect(transformed.properties?.boundedList).toMatchObject({
      type: "array",
      description: expect.stringContaining("0"),
    });
  });

  it("still rewrites an honest nested object/array schema", () => {
    const compatibility = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-pro",
    });
    const transformed = compatibility.transformToolSchema({
      type: "object",
      properties: {
        tags: {
          type: "array",
          maxItems: 4,
          items: { type: "string", maxLength: 32 },
        },
      },
    });
    expect(transformed.properties?.tags).toMatchObject({
      type: "array",
      description: expect.stringContaining("4"),
    });
  });

  it(`throws ${MCP_TOOL_SCHEMA_UNBOUNDED} one past depth ${MAX_MCP_SCHEMA_DEPTH}`, () => {
    const compatibility = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-pro",
    });
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < MAX_MCP_SCHEMA_DEPTH + 1; i++) {
      schema = { type: "array", items: schema };
    }
    expect(() => compatibility.transformToolSchema(schema as never)).toThrowError(ElizaError);
    try {
      compatibility.transformToolSchema(schema as never);
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(MCP_TOOL_SCHEMA_UNBOUNDED);
    }
  });

  it(`accepts a ${MAX_MCP_SCHEMA_DEPTH - 1}-deep items nest`, () => {
    const compatibility = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-pro",
    });
    // Each `{ type, items }` wrapper plus the leaf `type` string consumes a
    // depth slot; MAX wrappers puts the leaf string one past the budget.
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < MAX_MCP_SCHEMA_DEPTH - 1; i++) {
      schema = { type: "array", items: schema };
    }
    const transformed = compatibility.transformToolSchema(schema as never);
    expect(transformed.type).toBe("array");
  });

  it(`throws ${MCP_TOOL_SCHEMA_UNBOUNDED} past ${MAX_MCP_SCHEMA_NODES} nodes`, () => {
    const compatibility = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-pro",
    });
    const properties: Record<string, { type: "string" }> = {};
    // root + properties-object + N property schemas; N = MAX_MCP_SCHEMA_NODES
    // is one past the 2 + N budget.
    for (let i = 0; i < MAX_MCP_SCHEMA_NODES; i++) {
      properties[`k${i}`] = { type: "string" };
    }
    expect(() =>
      compatibility.transformToolSchema({
        type: "object",
        properties,
      })
    ).toThrowError(ElizaError);
  });

  it("throws MCP_TOOL_SCHEMA_UNBOUNDED on a cyclic items graph, not RangeError", () => {
    const compatibility = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-pro",
    });
    const cyclic = { type: "array", items: undefined as unknown };
    cyclic.items = cyclic;
    expect(() => compatibility.transformToolSchema(cyclic as never)).toThrowError(ElizaError);
    try {
      compatibility.transformToolSchema(cyclic as never);
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(MCP_TOOL_SCHEMA_UNBOUNDED);
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it("does not RangeError a 20k items nest", () => {
    const compatibility = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-pro",
    });
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 20_000; i++) {
      schema = { type: "array", items: schema };
    }
    expect(() => compatibility.transformToolSchema(schema as never)).toThrowError(ElizaError);
    try {
      compatibility.transformToolSchema(schema as never);
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(MCP_TOOL_SCHEMA_UNBOUNDED);
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it("enforces the budget when the provider does not apply fixup", () => {
    const compatibility = new OpenAIMcpCompatibility({
      provider: "openai",
      modelId: "gpt-4o",
      supportsStructuredOutputs: true,
    });
    const cyclic = { type: "array", items: undefined as unknown };
    cyclic.items = cyclic;
    expect(() => compatibility.transformToolSchema(cyclic as never)).toThrowError(ElizaError);
  });
});
