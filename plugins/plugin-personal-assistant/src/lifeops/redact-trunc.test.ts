/**
 * Exercises shortenSubject/shortenBody suffix reservation: truncated payload must not exceed advertised max before suffix.
 */
import { describe, expect, it } from "vitest";
import { shortenBody, shortenSubject } from "./redact-sensitive-data";

describe("shortenSubject", () => {
  it("never exceeds max inclusive of suffix", () => {
    const out = shortenSubject("a".repeat(100), 10);
    // shortenSubject returns prefix + ellipsis, length should be exactly max
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns original when under cap", () => {
    expect(shortenSubject("hello", 10)).toBe("hello");
  });

  it("handles max=1 edge", () => {
    const out = shortenSubject("hello", 1);
    expect(out).toBe("…");
    expect(out.length).toBe(1);
  });

  it("preserves cap across various lengths", () => {
    for (const cap of [5, 10, 20]) {
      const out = shortenSubject(
        "Hello world long subject that needs cutting",
        cap,
      );
      // prefix part before ellipsis is cap-1, plus ellipsis = cap
      expect(out.length).toBeLessThanOrEqual(cap);
      if ("Hello world long subject that needs cutting".length > cap)
        expect(out.endsWith("…")).toBe(true);
    }
  });
});

describe("shortenBody", () => {
  it("never exceeds max for prefix before suffix", () => {
    const body = "a".repeat(100);
    const out = shortenBody(body, 10);
    // prefix should be cap-1 + "…" then suffix
    expect(out.startsWith(`${"a".repeat(9)}… [+`)).toBe(true);
    const prefix = out.split(" [+")[0] ?? "";
    expect(prefix.length).toBe(10);
  });

  it("returns original when under cap", () => {
    expect(shortenBody("hello body", 20)).toBe("hello body");
  });

  it("handles max=1 edge", () => {
    const out = shortenBody("hello world body text", 1);
    expect(out.startsWith("… [+")).toBe(true);
  });
});
