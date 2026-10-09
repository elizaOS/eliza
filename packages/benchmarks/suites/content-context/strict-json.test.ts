/** Strict artifact parsing keeps native JSON semantics and rejects duplicate decoded keys. */
import { describe, expect, it } from "vitest";
import { parseStrictJson } from "./strict-json.ts";

describe("parseStrictJson", () => {
  it.each([
    "null",
    "true",
    "-1.25e+2",
    JSON.stringify('string containing { "key": [ ] }'),
    '{"a":1,"nested":{"a":2},"rows":[{"a":3},{"a":4}]}',
    '{"__proto__":1,"constructor":2,"":3}',
    '{"a:b":1,"a\\nb":2,"a\\\\b":3}',
    ' { "a" \n : [false, null, "b"], "b": {} } ',
  ])("preserves JSON semantics for %s", (source) => {
    expect(parseStrictJson(source, "artifact")).toEqual(JSON.parse(source));
  });

  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"\\ud83d\\ude00":1,"😀":2}',
    '{"":1,"":2}',
    '{"__proto__":1,"__proto__":2}',
    '[{"nested":{"key":1,"key":2}}]',
    '{"a":{"a":1},"a":2}',
    '{"a\\nb":1,"a\\u000ab":2}',
  ])("rejects decoded duplicate keys in %s", (source) => {
    expect(() => parseStrictJson(source, "artifact")).toThrow(
      "artifact is not valid strict JSON",
    );
  });

  it.each([
    '{"a":1,}',
    '{"a":NaN}',
    "{a:1}",
    '"unterminated',
    "[1] [2]",
    "# yaml\na: 1",
  ])("rejects non-JSON syntax in %s", (source) => {
    expect(() => parseStrictJson(source, "artifact")).toThrow(TypeError);
  });

  it("preserves every record in a large artifact", () => {
    const records = Array.from({ length: 10_000 }, (_, id) => ({
      id,
      text: 'quoted "key": { \\ escaped }',
      metadata: { id },
    }));
    expect(parseStrictJson(JSON.stringify(records), "large artifact")).toEqual(
      records,
    );
  });
});
