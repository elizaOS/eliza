import { describe, expect, it } from "vitest";
import { formatPromptSection, formatPromptValue } from "./prompt-format.ts";

describe("formatPromptValue", () => {
  it("renders primitives", () => {
    expect(formatPromptValue("hello")).toBe("hello");
    expect(formatPromptValue(42)).toBe("42");
    expect(formatPromptValue(true)).toBe("true");
    expect(formatPromptValue(null)).toBe("null");
    expect(formatPromptValue(undefined)).toBe("null");
  });

  it("renders empty strings as placeholders", () => {
    expect(formatPromptValue("   ")).toBe("(empty)");
    expect(formatPromptValue("")).toBe("(empty)");
  });

  it("renders arrays and objects", () => {
    expect(formatPromptValue([])).toBe("[]");
    expect(formatPromptValue({})).toBe("{}");
    expect(formatPromptValue([1, 2])).toBe("- 1\n- 2");
    expect(formatPromptValue({ a: 1 })).toBe("a: 1");
  });

  it("renders nested structures with indentation", () => {
    const out = formatPromptValue({ user: { name: "x", tags: ["a", "b"] } });
    expect(out).toContain("user:");
    expect(out).toContain("name: x");
    expect(out).toContain("- a");
  });
});

describe("formatPromptSection", () => {
  it("prepends the label", () => {
    expect(formatPromptSection("Context", "value")).toBe("Context:\nvalue");
  });
});
