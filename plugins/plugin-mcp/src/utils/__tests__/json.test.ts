/**
 * JSON utility tests for MCP model-output parsing and argument validation.
 * They cover fenced/prose-wrapped JSON extraction, JSON5 leniency, and schema checks for tool-call arguments.
 */

import { describe, expect, it } from "vitest";
import { parseJSON, parseStructuredModelOutput, validateJsonSchema } from "../json";

describe("parseJSON", () => {
  it("parses a plain JSON object", () => {
    expect(parseJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips a ```json markdown fence", () => {
    expect(parseJSON('```json\n{"a":1,"b":2}\n```')).toEqual({ a: 1, b: 2 });
  });

  it("extracts the object from surrounding prose (first { to last })", () => {
    expect(parseJSON('Sure, here it is: {"ok":true} — done')).toEqual({ ok: true });
  });

  it("accepts JSON5 leniency (unquoted keys, single quotes, trailing comma)", () => {
    expect(parseJSON("{ a: 1, b: 'two', }")).toEqual({ a: 1, b: "two" });
  });

  it("parses a nested object", () => {
    expect(parseJSON('{"a":{"b":2}}')).toEqual({ a: { b: 2 } });
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseJSON("no json here")).toThrow(/No valid JSON object/);
  });
});

describe("parseStructuredModelOutput", () => {
  it("returns the parsed object for valid (fenced) output", () => {
    expect(parseStructuredModelOutput('```\n{"x":42}\n```')).toEqual({ x: 42 });
  });
  it("throws a descriptive error when nothing parses", () => {
    expect(() => parseStructuredModelOutput("nope")).toThrow(/No valid JSON object found/);
  });
});

describe("validateJsonSchema", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  } as const;

  it("accepts data that satisfies the schema", () => {
    const result = validateJsonSchema<{ name: string }>({ name: "tool" }, schema);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("tool");
  });

  it("rejects data missing a required field, with an error message", () => {
    const result = validateJsonSchema({}, schema);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.length).toBeGreaterThan(0);
  });

  it("rejects a wrong-typed field", () => {
    const result = validateJsonSchema({ name: 123 }, schema);
    expect(result.success).toBe(false);
  });
});
