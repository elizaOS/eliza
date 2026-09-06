/** Exercises agent transport suffix trimming with ordinary and adversarial inputs. */

import { describe, expect, it } from "vitest";
import { trimEndCharacters } from "./string-boundaries.ts";

describe("agent string boundary scanner", () => {
  it("removes a trailing run and preserves interior characters", () => {
    expect(trimEndCharacters("https://example.test/path///", "/")).toBe(
      "https://example.test/path",
    );
  });

  it("handles a 100k-character suffix in linear time", () => {
    // The `toBe` below only proves correctness. Without an elapsed-time bound
    // a quadratic rewrite passes too: it finishes this input in ~33s, well
    // inside this package's 120s `testTimeout`. The linear scan takes under
    // 2ms, so a 1s budget fails on complexity rather than on a slow machine.
    const value = `base${"/".repeat(100_000)}`;
    const startedAt = performance.now();
    expect(trimEndCharacters(value, "/")).toBe("base");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("does not split an unmatched Unicode code point", () => {
    const allowed = String.fromCodePoint(0x1f600);
    const sameLowSurrogate = String.fromCodePoint(0x1f200);
    expect(trimEndCharacters(`base${sameLowSurrogate}`, allowed)).toBe(
      `base${sameLowSurrogate}`,
    );
  });
});
