import { describe, expect, it } from "vitest";
import {
  buildLlamaFunctions,
  extractToolCalls,
  toGbnfJsonSchema,
} from "../structured-output.js";

describe("structured-output", () => {
  describe("toGbnfJsonSchema", () => {
    it("returns undefined for nullish schema", () => {
      expect(toGbnfJsonSchema(undefined)).toBeUndefined();
    });

    it("forwards a plain JSON object schema", () => {
      const schema = {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      } as const;
      const out = toGbnfJsonSchema(schema as never);
      expect(out).toEqual(schema);
    });
  });

  describe("buildLlamaFunctions", () => {
    it("converts ToolDefinition[] into a name-keyed function map", () => {
      const tools = [
        {
          name: "get_weather",
          description: "Look up weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
        {
          name: "no_params_tool",
          description: "Side-effect only",
        },
      ];
      const fns = buildLlamaFunctions(tools as never);
      expect(Object.keys(fns).sort()).toEqual(["get_weather", "no_params_tool"]);
      expect(fns.get_weather.description).toBe("Look up weather for a city");
      expect(fns.get_weather.params).toBeDefined();
      expect(typeof fns.get_weather.handler).toBe("function");
      expect(fns.no_params_tool.params).toBeUndefined();
    });

    it("skips entries without a name", () => {
      const fns = buildLlamaFunctions([{ description: "nameless" } as never]);
      expect(Object.keys(fns)).toHaveLength(0);
    });
  });

  describe("extractToolCalls", () => {
    it("filters and shapes function-call entries", () => {
      const response = [
        "Some leading commentary",
        { type: "functionCall", name: "get_weather", params: { city: "Paris" }, result: undefined },
        "more text",
        { type: "functionCall", name: "lookup", params: { id: 7 }, result: undefined },
        { type: "segment", segmentType: "thought", text: "...", ended: true },
      ];
      const calls = extractToolCalls(response as never);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        id: "call_0",
        name: "get_weather",
        arguments: { city: "Paris" },
        type: "function",
      });
      expect(calls[1]).toMatchObject({
        id: "call_1",
        name: "lookup",
        arguments: { id: 7 },
        type: "function",
      });
    });

    it("returns empty when no function calls present", () => {
      expect(extractToolCalls(["just text"])).toEqual([]);
    });

    it("treats missing params as empty arguments", () => {
      const calls = extractToolCalls([
        { type: "functionCall", name: "ping", result: undefined },
      ] as never);
      expect(calls[0].arguments).toEqual({});
    });
  });
});
