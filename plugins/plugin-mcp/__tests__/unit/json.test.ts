import { describe, expect, it } from "vitest";
import { assertJsonObject, parseJSON, validateJsonSchema } from "../../src/utils/json";

describe("parseJSON", () => {
  it("should parse valid JSON", () => {
    const result = parseJSON<{ foo: string }>('{"foo": "bar"}');
    expect(result).toEqual({ foo: "bar" });
  });

  it("should handle JSON with code blocks", () => {
    const input = '```json\n{"foo": "bar"}\n```';
    const result = parseJSON<{ foo: string }>(input);
    expect(result).toEqual({ foo: "bar" });
  });

  it("should handle JSON with surrounding text", () => {
    const input = 'Here is the result: {"foo": "bar"} and some more text';
    const result = parseJSON<{ foo: string }>(input);
    expect(result).toEqual({ foo: "bar" });
  });

  it("should throw on invalid JSON", () => {
    expect(() => parseJSON("not valid json")).toThrow();
  });

  it("should throw on empty input", () => {
    expect(() => parseJSON("")).toThrow("No valid JSON object found in input");
  });

  it("should throw on input without braces", () => {
    expect(() => parseJSON("just some text")).toThrow("No valid JSON object found in input");
  });
});

describe("validateJsonSchema", () => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: {
      name: { type: "string", minLength: 1 },
      age: { type: "number", minimum: 0 },
    },
  };

  it("should validate correct data", () => {
    const result = validateJsonSchema({ name: "John", age: 30 }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "John", age: 30 });
    }
  });

  it("should reject missing required fields", () => {
    const result = validateJsonSchema({ name: "John" }, schema);
    expect(result.success).toBe(false);
  });

  it("should reject invalid types", () => {
    const result = validateJsonSchema({ name: "John", age: "thirty" }, schema);
    expect(result.success).toBe(false);
  });

  it("should reject values violating constraints", () => {
    const result = validateJsonSchema({ name: "John", age: -5 }, schema);
    expect(result.success).toBe(false);
  });
});

describe("assertJsonObject", () => {
  it("should return the object for valid objects", () => {
    const obj = { foo: "bar" };
    const result = assertJsonObject(obj, "test context");
    expect(result).toEqual(obj);
  });

  it("should throw for null", () => {
    expect(() => assertJsonObject(null, "test context")).toThrow();
  });

  it("should throw for arrays", () => {
    expect(() => assertJsonObject([], "test context")).toThrow();
  });

  it("should throw for primitives", () => {
    expect(() => assertJsonObject("string", "test context")).toThrow();
    expect(() => assertJsonObject(123, "test context")).toThrow();
    expect(() => assertJsonObject(true, "test context")).toThrow();
  });
});
