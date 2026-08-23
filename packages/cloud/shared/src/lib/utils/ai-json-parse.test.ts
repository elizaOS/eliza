/**
 * Coverage for AI JSON parse helper.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseAiJson } from "./ai-json-parse.js";

const schema = z.object({ a: z.number(), b: z.string() });

describe("parseAiJson", () => {
  it("parses plain json", () => {
    expect(parseAiJson('{"a":1,"b":"hi"}', schema)).toEqual({ a: 1, b: "hi" });
  });

  it("extracts from fence", () => {
    const fenced = '```json\n{"a":1,"b":"hi"}\n```';
    expect(parseAiJson(fenced, schema)).toEqual({ a: 1, b: "hi" });
  });

  it("extracts from surrounding text", () => {
    const wrapped = 'Sure! Here is json: {"a":1,"b":"hi"} thanks';
    expect(parseAiJson(wrapped, schema)).toEqual({ a: 1, b: "hi" });
  });

  it("throws on no json", () => {
    expect(() => parseAiJson("no json here", schema)).toThrow(/No JSON/);
  });

  it("throws on invalid json", () => {
    expect(() => parseAiJson("{bad}", schema)).toThrow(/Invalid JSON/);
  });

  it("throws on schema mismatch", () => {
    expect(() => parseAiJson('{"a":"oops","b":"hi"}', schema)).toThrow(/validation failed/);
  });

  it("includes context in error", () => {
    expect(() => parseAiJson("{bad}", schema, "myCtx")).toThrow(/myCtx/);
  });

  it("handles array json", () => {
    const arrSchema = z.array(z.number());
    expect(parseAiJson("[1,2,3]", arrSchema)).toEqual([1, 2, 3]);
  });
});
