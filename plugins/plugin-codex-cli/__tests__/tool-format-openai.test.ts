/**
 * Coverage for the OpenAI tool-format normalization — strict schema rewriting
 * that satisfies the codex backend's 400-rejecting strict rules.
 */
import { describe, expect, it } from "vitest";
import { toOpenAITool, toOpenAITools } from "../src/tool-format-openai.ts";

describe("toOpenAITool", () => {
  it("passes loose tools through without rewriting", () => {
    const params = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const out = toOpenAITool({
      name: "search",
      description: "Search",
      parameters: params,
    });
    expect(out.strict).toBe(false);
    expect(out.parameters).toBe(params);
    expect(out.name).toBe("search");
  });

  it("defaults strict to false and parameters to empty object", () => {
    const out = toOpenAITool({ name: "ping", description: "Ping" } as never);
    expect(out.strict).toBe(false);
    expect(out.parameters).toEqual({ type: "object", properties: {} });
  });

  it("normalizes strict schemas: required=all props, additionalProperties:false", () => {
    const out = toOpenAITool({
      name: "TASKS",
      description: "tasks",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "list"] },
          prompt: { type: "string" },
        },
        required: ["action"],
      },
    });
    expect(out.strict).toBe(true);
    expect(out.parameters).toEqual({
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list"] },
        prompt: { type: ["string", "null"] },
      },
      required: ["action", "prompt"],
      additionalProperties: false,
    });
  });

  it("makes originally-optional props nullable and keeps optional semantics", () => {
    const out = toOpenAITool({
      name: "FN",
      description: "fn",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "number" },
        },
        required: [],
      },
    }) as { parameters: { properties: Record<string, unknown> } };
    const props = out.parameters.properties as Record<string, { type: string[] }>;
    expect(props.a.type).toEqual(["string", "null"]);
    expect(props.b.type).toEqual(["number", "null"]);
  });

  it("does not double-add null when type already includes it", () => {
    const out = toOpenAITool({
      name: "FN",
      description: "fn",
      strict: true,
      parameters: {
        type: "object",
        properties: { a: { type: ["string", "null"] as unknown as string } },
        required: [],
      },
    }) as { parameters: { properties: Record<string, unknown> } };
    const prop = (out.parameters as { properties: Record<string, unknown> }).properties.a as {
      type: unknown[];
    };
    expect(prop.type).toEqual(["string", "null"]);
  });

  it("recurses into items and anyOf/oneOf/allOf", () => {
    const out = toOpenAITool({
      name: "FN",
      description: "fn",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
          },
          choice: {
            anyOf: [{ type: "object", properties: { y: { type: "string" } } }],
          },
        },
        required: ["items"],
      },
    }) as { parameters: Record<string, unknown> };
    const props = (out.parameters as { properties: Record<string, unknown> }).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect((props.items as { additionalProperties: unknown }).additionalProperties).toBe(false);
    expect((props.items as { required: unknown }).required).toEqual(["x"]);
  });

  it("normalizes arrays of schemas at the top level", () => {
    const out = toOpenAITool({
      name: "FN",
      description: "fn",
      strict: true,
      parameters: [{ type: "object", properties: { a: { type: "string" } } }] as unknown as object,
    });
    expect(Array.isArray(out.parameters)).toBe(true);
    const arr = out.parameters as unknown[];
    expect((arr[0] as { required: string[] }).required).toEqual(["a"]);
  });

  it("preserves tool name and description", () => {
    const out = toOpenAITool({
      name: "my_tool",
      description: "does stuff",
      strict: false,
      parameters: { type: "object", properties: {} },
    });
    expect(out.type).toBe("function");
    expect(out.name).toBe("my_tool");
    expect(out.description).toBe("does stuff");
  });

  it("falls back to empty object when parameters is null", () => {
    const out = toOpenAITool({
      name: "FN",
      description: "fn",
      strict: true,
      parameters: null as unknown as object,
    });
    expect(out.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});

describe("toOpenAITools", () => {
  it("maps an array of tools through toOpenAITool", () => {
    const tools = [
      { name: "a", description: "a", parameters: { type: "object", properties: {} } },
      {
        name: "b",
        description: "b",
        strict: true,
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    ];
    const out = toOpenAITools(tools as never);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("a");
    expect(out[1].strict).toBe(true);
    expect((out[1].parameters as { required: string[] }).required).toEqual(["x"]);
  });
});
