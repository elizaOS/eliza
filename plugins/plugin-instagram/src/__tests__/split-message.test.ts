import { describe, expect, it } from "vitest";
import { splitMessage } from "../service";

describe("splitMessage", () => {
  it("keeps surrogate pairs intact when splitting words by characters", () => {
    // 5 chars + emoji (2 code units) at position 5-6 + more chars
    // With maxLength = 6, naive slice(0, 6) splits the emoji surrogate pair.
    const text = "aaaaa\u{1F98A}bbbbb";
    const parts = splitMessage(text, 6);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.isWellFormed()).toBe(true);
      expect(part.length).toBeLessThanOrEqual(6);
    }
    expect(parts.join("")).toBe(text);
  });

  it("handles basic message splitting within limits", () => {
    const msg = "Hello world from instagram connector test";
    const parts = splitMessage(msg, 10);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(10);
    }
  });
});
