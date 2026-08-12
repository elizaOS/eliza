/**
 * Tests the UI-smoke shard selector parser against the real exported function.
 * Deterministic and dependency-free: the parser is pure string handling, so the
 * assertions cover the exact shard object CI hands to Playwright and every
 * malformed value that must abort instead of quietly running the whole suite.
 */
import { describe, expect, it } from "bun:test";
import { parseUiSmokeShard, UI_SMOKE_SHARD_ENV } from "./playwright-shard.mjs";

describe("parseUiSmokeShard", () => {
  it("returns the 1-indexed shard Playwright expects", () => {
    expect(parseUiSmokeShard("1/6")).toEqual({ current: 1, total: 6 });
    expect(parseUiSmokeShard("6/6")).toEqual({ current: 6, total: 6 });
  });

  it("tolerates surrounding whitespace from workflow interpolation", () => {
    expect(parseUiSmokeShard("  3/6\n")).toEqual({ current: 3, total: 6 });
  });

  it("runs the whole suite when no selector is set", () => {
    expect(parseUiSmokeShard(undefined)).toBeUndefined();
    expect(parseUiSmokeShard("")).toBeUndefined();
    expect(parseUiSmokeShard("   ")).toBeUndefined();
  });

  it("rejects a shard index past the total instead of running everything", () => {
    expect(() => parseUiSmokeShard("7/6")).toThrow(
      `${UI_SMOKE_SHARD_ENV} needs 1 <= current <= total, got "7/6"`,
    );
  });

  it("rejects a zero index and a zero total", () => {
    expect(() => parseUiSmokeShard("0/6")).toThrow(/1 <= current <= total/);
    expect(() => parseUiSmokeShard("1/0")).toThrow(/1 <= current <= total/);
  });

  it("rejects values that are not <current>/<total>", () => {
    for (const bad of [
      "6",
      "1/",
      "/6",
      "1//6",
      "a/6",
      "1/6/2",
      "-1/6",
      "1.5/6",
    ]) {
      expect(() => parseUiSmokeShard(bad)).toThrow(
        `${UI_SMOKE_SHARD_ENV} must be "<current>/<total>", got "${bad}"`,
      );
    }
  });

  it("covers every index exactly once across a full shard set", () => {
    const total = 6;
    const seen = Array.from({ length: total }, (_, index) =>
      parseUiSmokeShard(`${index + 1}/${total}`),
    );
    expect(seen.map((shard) => shard.current)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(seen.map((shard) => shard.total))).toEqual(new Set([total]));
  });
});
