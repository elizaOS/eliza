import { describe, expect, it } from "vitest";
import { extractCompatTextContent } from "./compat-utils";

describe("extractCompatTextContent", () => {
  it("passes a raw string through unchanged", () => {
    expect(extractCompatTextContent("hello")).toBe("hello");
    expect(extractCompatTextContent("")).toBe("");
  });

  it("joins text parts from an array, skipping non-text entries", () => {
    const content = [
      { type: "text", text: "first " },
      { type: "text", text: "second" },
      { type: "image", text: "ignored" },
      { type: "text", text: "" },
    ];
    expect(extractCompatTextContent(content)).toBe("first second");
  });

  it("skips non-object and missing-text array entries", () => {
    const content = [null, 42, "raw", { text: "kept" }, { type: "text" }];
    expect(extractCompatTextContent(content)).toBe("kept");
  });

  it("keeps text-only array entries even without an explicit type", () => {
    expect(extractCompatTextContent([{ text: "a" }, { text: "b" }])).toBe("ab");
  });

  it("reads a { text } object payload", () => {
    expect(extractCompatTextContent({ text: "object text" })).toBe(
      "object text",
    );
  });

  it("returns empty string for a { text } object with non-string text", () => {
    expect(extractCompatTextContent({ text: 123 })).toBe("");
    expect(extractCompatTextContent({ text: "" })).toBe("");
  });

  it("returns empty string for unsupported shapes", () => {
    expect(extractCompatTextContent(null)).toBe("");
    expect(extractCompatTextContent(undefined)).toBe("");
    expect(extractCompatTextContent(42)).toBe("");
    expect(extractCompatTextContent(true)).toBe("");
  });

  it("drops text entries whose type is not the string 'text'", () => {
    expect(extractCompatTextContent([{ type: "Text", text: "x" }])).toBe("");
    expect(extractCompatTextContent([{ type: "text", text: "x" }])).toBe("x");
  });
});
