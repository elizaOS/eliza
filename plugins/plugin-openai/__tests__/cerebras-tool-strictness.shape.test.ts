/**
 * Validates the request-wide strictness and zero-argument schema contracts
 * required by Cerebras's OpenAI-compatible tool grammar.
 */

import { describe, expect, it } from "vitest";
import { __INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall } from "../models/text";

interface WireTool {
  strict?: boolean;
  inputSchema: {
    jsonSchema: unknown;
  };
}

function normalizeForCerebras(tools: Array<Record<string, unknown>>): Record<string, WireTool> {
  const normalized = normalizeNativeToolsForCall(tools, {
    cerebrasMode: true,
  }).tools;
  if (!normalized) throw new Error("expected normalized Cerebras tools");
  return normalized as unknown as Record<string, WireTool>;
}

function populatedSchema() {
  return {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
}

function expectUniformStrictness(tools: Record<string, WireTool>, expected: boolean): void {
  expect(Object.values(tools).map((tool) => tool.strict)).toEqual(
    Object.values(tools).map(() => expected)
  );
}

describe("Cerebras native tool strictness", () => {
  it("keeps every tool strict only when every declaration is explicitly strict", () => {
    const tools = normalizeForCerebras([
      { name: "first", strict: true, parameters: populatedSchema() },
      { name: "second", strict: true, parameters: populatedSchema() },
    ]);

    expectUniformStrictness(tools, true);
  });

  it("makes a mixed true/false tool array uniformly non-strict", () => {
    const tools = normalizeForCerebras([
      { name: "strict_tool", strict: true, parameters: populatedSchema() },
      { name: "non_strict_tool", strict: false, parameters: populatedSchema() },
    ]);

    expectUniformStrictness(tools, false);
  });

  it("makes an all-false tool array uniformly non-strict", () => {
    const tools = normalizeForCerebras([
      { name: "first", strict: false, parameters: populatedSchema() },
      { name: "second", strict: false, parameters: populatedSchema() },
    ]);

    expectUniformStrictness(tools, false);
  });

  it("makes an omitted flag uniformly non-strict and closes zero-argument schemas", () => {
    const tools = normalizeForCerebras([
      { name: "strict_tool", strict: true, parameters: populatedSchema() },
      { name: "zero_arg_tool" },
    ]);

    expectUniformStrictness(tools, false);
    expect(tools.zero_arg_tool?.inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});
