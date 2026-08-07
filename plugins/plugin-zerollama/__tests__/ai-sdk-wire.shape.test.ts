/** Exercises the real AI SDK schema wrapper used for stock-Ollama tool calls. */
import { describe, expect, it } from "vitest";
import { normalizeNativeTools } from "../utils/ai-sdk-wire";

describe("Ollama AI SDK wire normalization", () => {
  it("wraps raw ToolSet JSON schemas in the AI SDK v6 schema contract", () => {
    const tools = normalizeNativeTools({
      lookup: {
        description: "Lookup",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    }) as Record<string, { inputSchema: { jsonSchema?: unknown; validate?: unknown } }>;

    expect(tools.lookup.inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect("validate" in tools.lookup.inputSchema).toBe(true);
  });

  it("rejects a named ToolSet entry with no input schema", () => {
    expect(() => normalizeNativeTools({ lookup: { description: "Lookup" } })).toThrow(
      "missing an input schema"
    );
  });
});
