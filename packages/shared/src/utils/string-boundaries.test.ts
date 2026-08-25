/** Exercises the deterministic string-boundary scanners, including adversarial long runs. */

import { describe, expect, it } from "vitest";
import {
  trimBoundaryCharacters,
  trimEndCharacters,
  trimStartCharacters,
} from "./string-boundaries";

describe("string boundary scanners", () => {
  it("preserves ordinary boundary semantics", () => {
    expect(trimStartCharacters("///path", "/")).toBe("path");
    expect(trimEndCharacters("path///", "/")).toBe("path");
    expect(trimBoundaryCharacters("---view---", "-")).toBe("view");
  });

  it("handles 100k-character boundary runs without backtracking", () => {
    const run = "/".repeat(100_000);
    expect(trimStartCharacters(`${run}path`, "/")).toBe("path");
    expect(trimEndCharacters(`path${run}`, "/")).toBe("path");
    expect(trimBoundaryCharacters(`${run}path${run}`, "/")).toBe("path");
  });

  it("is linear in both the input and candidate set", () => {
    const candidates = `${Array.from({ length: 10_000 }, (_, index) =>
      String.fromCodePoint(0x1000 + index),
    ).join("")}x`;
    expect(trimEndCharacters(`base${"x".repeat(100_000)}`, candidates)).toBe(
      "base",
    );
  });

  it("compares Unicode code points without splitting shared surrogates", () => {
    const allowed = String.fromCodePoint(0x1f600);
    const sameHighSurrogate = String.fromCodePoint(0x1f601);
    const sameLowSurrogate = String.fromCodePoint(0x1f200);
    expect(trimStartCharacters(`${sameHighSurrogate}value`, allowed)).toBe(
      `${sameHighSurrogate}value`,
    );
    expect(trimEndCharacters(`value${sameLowSurrogate}`, allowed)).toBe(
      `value${sameLowSurrogate}`,
    );
  });
});
