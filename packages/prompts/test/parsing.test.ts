/**
 * Tests for `extractAndParseJSONObjectFromText`, the model-output JSON parser:
 * it turns a model's text into a structured object, so a regression here breaks
 * every structured model output. Deterministic — exercises the parser on fixed
 * strings, no live model.
 */
import { describe, expect, it } from "bun:test";
import {
  extractAndParseJSONObjectFromText,
  parseJSONObjectFromText,
} from "../src/parsing.ts";

describe("extractAndParseJSONObjectFromText", () => {
  it("parses a plain JSON object", () => {
    expect(extractAndParseJSONObjectFromText('{"a":1,"b":"two"}')).toEqual({
      a: 1,
      b: "two",
    });
  });

  it("parses a JSON array", () => {
    expect(extractAndParseJSONObjectFromText("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("parses a model JSON value beyond the former 100,000-character boundary", () => {
    const sentinel = "END_OF_COMPLETE_MODEL_OUTPUT";
    const value = `${"x".repeat(1_100_000)}${sentinel}`;
    expect(
      extractAndParseJSONObjectFromText(JSON.stringify({ value })),
    ).toEqual({ value });
  });

  it("extracts JSON from a ```json fenced block surrounded by prose", () => {
    expect(
      extractAndParseJSONObjectFromText(
        'here you go:\n```json\n{"ok":true}\n```\nthanks',
      ),
    ).toEqual({ ok: true });
  });

  it("accepts JSON5 leniency (unquoted keys, single quotes, trailing comma)", () => {
    expect(extractAndParseJSONObjectFromText("{ a: 1, b: 'two', }")).toEqual({
      a: 1,
      b: "two",
    });
  });

  it("throws on empty / non-string input", () => {
    expect(() => extractAndParseJSONObjectFromText("")).toThrow(
      /non-empty string/,
    );
  });

  it("throws on unparseable text", () => {
    expect(() =>
      extractAndParseJSONObjectFromText("this is not json at all"),
    ).toThrow(/Failed to parse/);
  });

  it("throws when parsed JSON is a primitive scalar", () => {
    expect(() => extractAndParseJSONObjectFromText("null")).toThrow(
      /Failed to parse/,
    );
    expect(() => extractAndParseJSONObjectFromText("123")).toThrow(
      /Failed to parse/,
    );
    expect(() => extractAndParseJSONObjectFromText("true")).toThrow(
      /Failed to parse/,
    );
    expect(() => extractAndParseJSONObjectFromText('"just a string"')).toThrow(
      /Failed to parse/,
    );
  });
});

describe("parseJSONObjectFromText", () => {
  it("recovers an object from surrounding prose, null on failure or arrays", () => {
    expect(parseJSONObjectFromText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJSONObjectFromText('```json\n{"ok": true}\n```')).toEqual({
      ok: true,
    });
    expect(parseJSONObjectFromText("[1,2,3]")).toBeNull(); // arrays are not objects
    expect(parseJSONObjectFromText("no json")).toBeNull();
  });

  it("returns null for scalars, which JSON5 parses as valid JSON", () => {
    expect(parseJSONObjectFromText("42")).toBeNull();
    expect(parseJSONObjectFromText("true")).toBeNull();
    expect(parseJSONObjectFromText("null")).toBeNull();
    // A model reply wrapped in quotes is a JSON string, not an object.
    expect(
      parseJSONObjectFromText('"Sure - I added milk to your shopping list."'),
    ).toBeNull();
  });
});
