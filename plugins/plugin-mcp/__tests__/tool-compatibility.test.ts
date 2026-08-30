/**
 * Regression coverage for provider-specific MCP schema transformations using
 * deterministic JSON Schema inputs and no external MCP server.
 *
 * Also covers the fail-closed budget on attacker-controlled tool inputSchema
 * graphs: cyclic `items` used to RangeError `processSchema`.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { GoogleMcpCompatibility } from "../src/tool-compatibility/providers/google.ts";
import {
  OpenAIMcpCompatibility,
  OpenAIReasoningMcpCompatibility,
} from "../src/tool-compatibility/providers/openai.ts";
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

  // A JSON Schema `type` array such as ["string","null"] is the standard
  // nullable/optional encoding emitted by Zod .nullable() and many MCP
  // servers. The dispatch switch never matched these nodes, so provider-
  // unsupported keywords survived on every nullable field and everything
  // nested under a nullable object/array, then 400ed at strict function-
  // calling providers (Gemini/OpenAI). These cases pin the fixed contract.
  describe("nullable (union) typed nodes", () => {
    const google = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-1.5-pro",
    });
    const reasoning = new OpenAIReasoningMcpCompatibility({
      provider: "openai",
      modelId: "o3-mini",
      isReasoningModel: true,
    });

    it("strips format/pattern/minLength on a nullable string and folds them into the description (Google)", () => {
      const out = google.transformToolSchema({
        type: "object",
        properties: {
          email: {
            type: ["string", "null"],
            format: "email",
            pattern: "^x@",
            minLength: 3,
          },
        },
      } as never);
      const email = out.properties?.email as Record<string, unknown>;
      // The nullable `type` array is preserved so the field stays optional.
      expect(email.type).toEqual(["string", "null"]);
      expect(email.format).toBeUndefined();
      expect(email.pattern).toBeUndefined();
      expect(email.minLength).toBeUndefined();
      expect(email.description).toContain("at least 3 characters");
      expect(email.description).toContain("valid email");
    });

    it("strips minimum/maximum on a nullable integer (Google)", () => {
      const out = google.transformToolSchema({
        type: "object",
        properties: {
          age: { type: ["integer", "null"], minimum: 0, maximum: 120 },
        },
      } as never);
      const age = out.properties?.age as Record<string, unknown>;
      expect(age.type).toEqual(["integer", "null"]);
      expect(age.minimum).toBeUndefined();
      expect(age.maximum).toBeUndefined();
      expect(age.description).toContain("at least 0");
      expect(age.description).toContain("no more than 120");
    });

    it("recurses into items of a nullable array and strips child keywords (Google)", () => {
      const out = google.transformToolSchema({
        type: "object",
        properties: {
          tags: {
            type: ["array", "null"],
            minItems: 1,
            items: { type: "string", maxLength: 8 },
          },
        },
      } as never);
      const tags = out.properties?.tags as Record<string, unknown>;
      expect(tags.type).toEqual(["array", "null"]);
      expect(tags.minItems).toBeUndefined();
      const items = tags.items as Record<string, unknown>;
      expect(items.maxLength).toBeUndefined();
      expect(items.description).toContain("no more than 8");
    });

    it("recurses into a nullable object's nested properties (Google)", () => {
      const out = google.transformToolSchema({
        type: "object",
        properties: {
          profile: {
            type: ["object", "null"],
            properties: { name: { type: "string", maxLength: 5 } },
          },
        },
      } as never);
      const profile = out.properties?.profile as Record<string, unknown>;
      expect(profile.type).toEqual(["object", "null"]);
      const props = profile.properties as Record<string, Record<string, unknown>>;
      expect(props.name.maxLength).toBeUndefined();
      expect(props.name.description).toContain("no more than 5");
    });

    it("strips format/pattern on a nullable string for OpenAI reasoning models", () => {
      const out = reasoning.transformToolSchema({
        type: "object",
        properties: {
          email: {
            type: ["string", "null"],
            format: "email",
            pattern: "^x@",
            minLength: 2,
          },
        },
      } as never);
      const email = out.properties?.email as Record<string, unknown>;
      expect(email.type).toEqual(["string", "null"]);
      expect(email.format).toBeUndefined();
      expect(email.pattern).toBeUndefined();
      expect(email.minLength).toBeUndefined();
      expect(String(email.description)).toContain("IMPORTANT");
    });

    it("leaves a plain (non-union) typed schema behavior-identical (regression guard)", () => {
      const unionOut = google.transformToolSchema({
        type: "object",
        properties: {
          email: { type: ["string"], format: "email", pattern: "^x@" },
        },
      } as never);
      const scalarOut = google.transformToolSchema({
        type: "object",
        properties: {
          email: { type: "string", format: "email", pattern: "^x@" },
        },
      } as never);
      const unionEmail = unionOut.properties?.email as Record<string, unknown>;
      const scalarEmail = scalarOut.properties?.email as Record<string, unknown>;
      // A single-member union carries the same stripped keywords and folded
      // description as its scalar equivalent; only `type` differs in shape.
      expect(unionEmail.format).toBeUndefined();
      expect(scalarEmail.format).toBeUndefined();
      expect(unionEmail.description).toEqual(scalarEmail.description);
    });

    it("still runs combinator handling under a nullable node (cleans anyOf children)", () => {
      // The nullable branch ends in processGenericSchema so oneOf/anyOf/allOf
      // members carried alongside an array `type` are still recursed and
      // cleaned. Without that final call the child keywords leak to strict
      // providers exactly as they did for the top-level nullable node.
      const out = google.transformToolSchema({
        type: "object",
        properties: {
          child: {
            type: ["object", "null"],
            anyOf: [{ type: "string", format: "email", pattern: "^x$", description: "child" }],
          },
        },
      } as never);
      const child = out.properties?.child as Record<string, unknown>;
      const anyOf = child.anyOf as Array<Record<string, unknown>>;
      expect(anyOf[0].format).toBeUndefined();
      expect(anyOf[0].pattern).toBeUndefined();
      expect(String(anyOf[0].description)).toContain("valid email");
    });

    it("folds a multi-concrete union canonically regardless of member order", () => {
      // JSON Schema `type` arrays are unordered sets, so semantically identical
      // schemas that differ only in member order must transform identically.
      const build = (types: string[]) =>
        google.transformToolSchema({
          type: "object",
          properties: {
            id: { type: types, pattern: "^a+$", minimum: 3, maximum: 9 },
          },
        } as never);
      const forward = build(["string", "integer"]).properties?.id as Record<string, unknown>;
      const reversed = build(["integer", "string"]).properties?.id as Record<string, unknown>;
      expect(reversed.description).toEqual(forward.description);
    });
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

  it("rejects a provider rewrite that expands beyond the retained-schema byte cap", () => {
    const compatibility = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-pro",
    });
    expect(() =>
      compatibility.transformToolSchema({
        type: "string",
        pattern: "x".repeat(262_055),
      })
    ).toThrowError(ElizaError);
  });
});
