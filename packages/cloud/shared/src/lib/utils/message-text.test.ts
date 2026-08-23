/**
 * Coverage for message-text.
 */
import { describe, expect, it } from "vitest";
import { extractTextFromContent } from "./message-text.js";
describe("message-text", () => {
  it("extracts text", () => {
    expect(extractTextFromContent({ text: "hello" })).toBe("hello");
  });
  it("prioritizes text field", () => {
    expect(extractTextFromContent({ text: "a", body: "b" })).toBe("a");
  });
  it("handles nested content", () => {
    expect(extractTextFromContent({ content: { text: "nested" } })).toBe("nested");
  });
  it("returns empty for invalid", () => {
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent({})).toBe("");
  });
});
