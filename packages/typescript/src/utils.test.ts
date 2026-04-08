import { describe, it, expect } from "vitest";
import { parseJSONObjectFromText } from "./utils";

describe("parseJSONObjectFromText", () => {
  it("should parse valid JSON object from text", () => {
    const result = parseJSONObjectFromText('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("should parse JSON from code block", () => {
    const result = parseJSONObjectFromText('```json\n{"key": "value"}\n```');
    expect(result).toEqual({ key: "value" });
  });

  it("should return null for invalid JSON", () => {
    const result = parseJSONObjectFromText("not valid json");
    expect(result).toBeNull();
  });

  it("should return null for JSON arrays", () => {
    const result = parseJSONObjectFromText("[1, 2, 3]");
    expect(result).toBeNull();
  });

  it("should return null for empty input", () => {
    const result = parseJSONObjectFromText("");
    expect(result).toBeNull();
  });

  it("should preserve numeric values as numbers", () => {
    const result = parseJSONObjectFromText('{"count": 42, "price": 19.99}');
    expect(result).toEqual({ count: 42, price: 19.99 });
    expect(typeof result?.count).toBe("number");
    expect(typeof result?.price).toBe("number");
  });
});
