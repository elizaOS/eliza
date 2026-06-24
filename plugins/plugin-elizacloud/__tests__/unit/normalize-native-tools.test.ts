/**
 * Regression tests for normalizeNativeTools — the tool-shape coercion that feeds
 * the cloud /chat/completions native-tool path.
 *
 * Bug it guards: elizaOS core emits a FLAT `ToolDefinition` envelope
 * (`{ name, description, type: "function", parameters }`) from
 * createHandleResponseTool() / the action planner. The previous
 * implementation returned array-form tools verbatim, so the cloud gateway's
 * `toGatewayTools` read `tool.function.name` on an undefined `function` and
 * threw "Cannot read properties of undefined (reading 'name')" — a 500 that
 * the agent surfaced as "something went wrong on my end" on every native-tool
 * (should-respond / RESPONSE_HANDLER) turn.
 */
import { describe, expect, it } from "vitest";
import { normalizeNativeToolChoice, normalizeNativeTools } from "../../src/models/text";

type NativeTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
};

describe("normalizeNativeTools", () => {
  it("wraps a flat ToolDefinition array into the OpenAI {type, function} shape", () => {
    const flat = [
      {
        name: "HANDLE_RESPONSE",
        description: "Decide whether and how to respond",
        type: "function",
        strict: true,
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ];

    const result = normalizeNativeTools(flat) as NativeTool[];
    expect(result).toHaveLength(1);
    const [tool] = result;
    // The gateway reads tool.function.name — it must be defined now.
    expect(tool.type).toBe("function");
    expect(tool.function).toBeDefined();
    expect(tool.function.name).toBe("HANDLE_RESPONSE");
    expect(tool.function.description).toBe("Decide whether and how to respond");
    expect(tool.function.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  it("preserves tools already in the nested {type, function} shape", () => {
    const nested = [
      {
        type: "function",
        function: {
          name: "GET_WEATHER",
          description: "Look up weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const result = normalizeNativeTools(nested) as NativeTool[];
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("GET_WEATHER");
    expect(result[0].function.description).toBe("Look up weather");
  });

  it("normalizes the record/map form (name keyed) into wire shape", () => {
    const record = {
      SEARCH: {
        description: "search",
        parameters: { type: "object" },
      },
    };

    const result = normalizeNativeTools(record) as NativeTool[];
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("SEARCH");
  });

  it("drops nameless entries instead of throwing downstream", () => {
    const result = normalizeNativeTools([
      { type: "function", parameters: { type: "object" } }, // no name anywhere
      { name: "OK", type: "function", parameters: { type: "object" } },
    ]) as NativeTool[];
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("OK");
  });

  it("accepts inputSchema/schema aliases for parameters", () => {
    const result = normalizeNativeTools([
      { name: "A", inputSchema: { type: "object", title: "viaInput" } },
      { name: "B", schema: { type: "object", title: "viaSchema" } },
    ]) as NativeTool[];
    expect(result[0].function.parameters).toMatchObject({ title: "viaInput" });
    expect(result[1].function.parameters).toMatchObject({ title: "viaSchema" });
  });

  it("returns undefined for empty / falsy tool inputs", () => {
    expect(normalizeNativeTools(undefined)).toBeUndefined();
    expect(normalizeNativeTools(null)).toBeUndefined();
    expect(normalizeNativeTools([])).toBeUndefined();
    expect(normalizeNativeTools({})).toBeUndefined();
  });
});

describe("normalizeNativeToolChoice", () => {
  it("wraps a flat function choice into the OpenAI {type, function} shape", () => {
    const result = normalizeNativeToolChoice({
      type: "function",
      name: "HANDLE_RESPONSE",
    }) as NativeTool;

    expect(result).toEqual({
      type: "function",
      function: { name: "HANDLE_RESPONSE" },
    });
  });

  it("preserves a nested function choice while guaranteeing function.name", () => {
    const result = normalizeNativeToolChoice({
      type: "function",
      function: {
        name: "GET_WEATHER",
      },
    }) as NativeTool;

    expect(result).toEqual({
      type: "function",
      function: { name: "GET_WEATHER" },
    });
  });

  it("normalizes tool-choice aliases and drops nameless function choices", () => {
    expect(normalizeNativeToolChoice({ type: "tool", toolName: "SEARCH" })).toEqual({
      type: "function",
      function: { name: "SEARCH" },
    });
    expect(normalizeNativeToolChoice({ type: "function" })).toBeUndefined();
  });
});
