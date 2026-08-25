/**
 * Verifies vault input helpers and the leaf-local Unicode compatibility path,
 * including runtimes without native well-formed string methods.
 */

import { describe, expect, it } from "vitest";
import {
  assertKey,
  optsCaller,
  toWellFormedUnicode,
  truncateWellFormed,
} from "../internal-utils.js";

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

describe("well-formed truncation", () => {
  it("normalizes lone surrogate to U+FFFD", () => {
    expect(toWellFormedUnicode("a\uD800b")).toBe("a\uFFFDb");
  });
  it("does not split surrogate pair at truncation boundary", () => {
    expect(
      truncateWellFormed(`${"x".repeat(199)}🦊${"y".repeat(10)}`, 200),
    ).toBe("x".repeat(199));
    expect(truncateWellFormed(`${"x".repeat(198)}🦊`, 200)).toBe(
      `${"x".repeat(198)}🦊`,
    );
  });

  it("uses the compatibility normalizer when native helpers are unavailable", () => {
    const toWellFormed = Object.getOwnPropertyDescriptor(
      String.prototype,
      "toWellFormed",
    );
    const isWellFormed = Object.getOwnPropertyDescriptor(
      String.prototype,
      "isWellFormed",
    );
    Object.defineProperty(String.prototype, "toWellFormed", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(String.prototype, "isWellFormed", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(toWellFormedUnicode("a\uD800b\uDC00c🦊")).toBe("a�b�c🦊");
    } finally {
      if (toWellFormed) {
        Object.defineProperty(String.prototype, "toWellFormed", toWellFormed);
      } else {
        Reflect.deleteProperty(String.prototype, "toWellFormed");
      }
      if (isWellFormed) {
        Object.defineProperty(String.prototype, "isWellFormed", isWellFormed);
      } else {
        Reflect.deleteProperty(String.prototype, "isWellFormed");
      }
    }
  });
});
