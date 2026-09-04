// Exercises the numeric-setting guard that bounds the native planner's loops.
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { positiveIntSetting } from "./native-planner-guards";

function runtimeWith(value: unknown): IAgentRuntime {
  return { getSetting: () => value } as unknown as IAgentRuntime;
}

describe("positiveIntSetting", () => {
  test("uses a configured positive integer", () => {
    expect(positiveIntSetting(runtimeWith("5"), "K", 2)).toBe(5);
  });

  test("falls back when the setting is absent", () => {
    expect(positiveIntSetting(runtimeWith(undefined), "K", 2)).toBe(2);
    expect(positiveIntSetting({} as IAgentRuntime, "K", 2)).toBe(2);
  });

  // Each of these previously reached `parseInt` and produced NaN or 0. Every
  // comparison against NaN is false, so `while (i < max)` and
  // `for (a = 1; a <= max; a++)` do not error -- they silently never run, and a
  // `failures >= max` cap never trips.
  test.each([
    ["an empty string, as an env file writes `FOO=`", ""],
    ["whitespace", "   "],
    ["a non-numeric word", "default"],
    ["zero", "0"],
    ["a negative count", "-1"],
    ["a fractional count", "1.5"],
    ["a null setting", null],
    ["a boolean setting", true],
  ])("falls back on %s", (_label, raw) => {
    expect(positiveIntSetting(runtimeWith(raw), "K", 2)).toBe(2);
  });

  test("accepts a number-typed setting without string coercion", () => {
    expect(positiveIntSetting(runtimeWith(7), "K", 2)).toBe(7);
  });

  test("a NaN bound would have made every loop guard false", () => {
    // Pins the mechanism the guard exists to prevent.
    const bad = Number.parseInt(String("" ?? "2"), 10);
    expect(Number.isNaN(bad)).toBe(true);
    expect(0 < bad).toBe(false);
    expect(1 <= bad).toBe(false);
    expect(9 >= bad).toBe(false);
  });
});
