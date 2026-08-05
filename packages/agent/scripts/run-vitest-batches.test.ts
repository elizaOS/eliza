/** Tests deterministic batching and strict concurrency configuration without spawning Vitest. */
import { describe, expect, test } from "vitest";
import { createBatches, positiveInteger } from "./run-vitest-batches.mjs";

describe("agent Vitest batch orchestration", () => {
  test("keeps sorted file membership isolated and complete", () => {
    expect(createBatches(["a.test.ts", "b.test.ts", "c.test.ts"], 1)).toEqual([
      ["a.test.ts"],
      ["b.test.ts"],
      ["c.test.ts"],
    ]);
    expect(createBatches(["a.test.ts", "b.test.ts", "c.test.ts"], 2)).toEqual([
      ["a.test.ts", "b.test.ts"],
      ["c.test.ts"],
    ]);
  });

  test("uses defaults only when unset and rejects malformed values", () => {
    expect(positiveInteger(undefined, "TEST_VALUE", 4)).toBe(4);
    expect(positiveInteger("", "TEST_VALUE", 4)).toBe(4);
    expect(positiveInteger("8", "TEST_VALUE", 4)).toBe(8);
    for (const value of ["0", "-1", "1.5", "abc", "999999999999999999999"]) {
      expect(() => positiveInteger(value, "TEST_VALUE", 4)).toThrow(
        "TEST_VALUE must be a positive integer.",
      );
    }
  });
});
