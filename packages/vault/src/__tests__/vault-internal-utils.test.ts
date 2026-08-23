import { describe, expect, it } from "vitest";
import { assertKey, optsCaller } from "../internal-utils.js";

describe("assertKey", () => {
  it("accepts valid keys", () => {
    expect(() => assertKey("my-key")).not.toThrow();
    expect(() => assertKey("a".repeat(256))).not.toThrow();
  });

  it("rejects empty and non-string keys", () => {
    expect(() => assertKey("")).toThrow("non-empty");
    expect(() => assertKey("   ")).toThrow("non-empty");
    expect(() => assertKey(5 as never)).toThrow("non-empty");
  });

  it("rejects overlong keys", () => {
    expect(() => assertKey("a".repeat(257))).toThrow("256");
  });
});

describe("optsCaller", () => {
  it("extracts the caller when present", () => {
    expect(optsCaller({ caller: "me" } as never)).toEqual({ caller: "me" });
  });

  it("returns empty when absent", () => {
    expect(optsCaller({} as never)).toEqual({});
  });
});

import { toWellFormedUnicode, truncateWellFormed } from "../internal-utils.js";

describe("well-formed truncation", () => {
  it("normalizes lone surrogate to U+FFFD", () => {
    expect(toWellFormedUnicode("a\uD800b")).toBe("a\uFFFDb");
  });
  it("does not split surrogate pair at truncation boundary", () => {
    expect(
      truncateWellFormed("x".repeat(199) + "🦊" + "y".repeat(10), 200),
    ).toBe("x".repeat(199));
    expect(truncateWellFormed("x".repeat(198) + "🦊", 200)).toBe(
      "x".repeat(198) + "🦊",
    );
  });
});
