/**
 * Exercises service-local Unicode normalization with native well-formed string
 * helpers disabled so the compatibility algorithm is covered deterministically.
 */

import { describe, expect, it } from "vitest";
import { toWellFormedUnicode, truncateWellFormed } from "./text";

function withoutNativeWellFormed<T>(run: () => T): T {
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
    return run();
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
}

describe("service Unicode compatibility helpers", () => {
  it("replaces lone surrogates while preserving valid pairs without natives", () => {
    withoutNativeWellFormed(() => {
      expect(toWellFormedUnicode("a\uD800b\uDC00c🦊")).toBe("a�b�c🦊");
    });
  });

  it("does not split a surrogate pair at the truncation boundary", () => {
    expect(truncateWellFormed(`${"x".repeat(9)}🦊tail`, 10)).toBe(
      "x".repeat(9),
    );
  });
});
