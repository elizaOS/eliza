import { describe, expect, it } from "vitest";
import { extractJsonFromText, handleObjectGenerationError } from "../utils/helpers";

/**
 * extractJsonFromText is the fallback chain that recovers a JSON object from a
 * model's text completion: raw JSON → ```json fenced block → generic fenced
 * block (only if it looks like an object) → first {...} span. A miss returns {}
 * rather than throwing, so structured-output handlers degrade gracefully on
 * chatty model responses.
 */

describe("extractJsonFromText", () => {
  it("parses a raw JSON object", () => {
    expect(extractJsonFromText('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("extracts from a ```json fenced block", () => {
    const text = 'Here you go:\n```json\n{ "ok": true }\n```\nThanks!';
    expect(extractJsonFromText(text)).toEqual({ ok: true });
  });

  it("extracts from a generic fenced block when it looks like an object", () => {
    expect(extractJsonFromText('```\n{"n": 2}\n```')).toEqual({ n: 2 });
  });

  it("falls back to the first brace-delimited span in prose", () => {
    expect(extractJsonFromText('the result is {"value": 42} ok')).toEqual({ value: 42 });
  });

  it("returns {} when no JSON can be recovered", () => {
    expect(extractJsonFromText("no json here at all")).toEqual({});
  });
});

describe("handleObjectGenerationError", () => {
  it("wraps the error message under an error key", () => {
    expect(handleObjectGenerationError(new Error("boom"))).toEqual({ error: "boom" });
    expect(handleObjectGenerationError("plain")).toEqual({ error: "plain" });
  });
});
