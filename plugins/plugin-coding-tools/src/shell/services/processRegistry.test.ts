/**
 * Boundary tests for `parseJobTtlMs` (the SHELL_JOB_TTL_MS validator). The
 * bug (#19303) was that `Number.parseInt` followed by `Math.min/max` silently
 * clamped malformed values to the minimum. The contract now mirrors the
 * other folded ShellService numeric compatibility settings: canonical
 * decimal integer in [`60000`, `10800000`] or a typed error.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { parseJobTtlMs } from "./processRegistry";

const MIN = 60_000;
const MAX = 3 * 60 * 60 * 1000;
const DEFAULT = 30 * 60 * 1000;

describe("parseJobTtlMs (SHELL_JOB_TTL_MS)", () => {
  test("returns undefined on missing or empty so the source-of-truth default holds", () => {
    expect(parseJobTtlMs(undefined)).toBeUndefined();
    expect(parseJobTtlMs("")).toBeUndefined();
  });

  test("accepts canonical decimal integers across the documented range", () => {
    expect(parseJobTtlMs(String(MIN))).toEqual({ value: MIN });
    expect(parseJobTtlMs(String(MAX))).toEqual({ value: MAX });
    expect(parseJobTtlMs("1800000")).toEqual({ value: DEFAULT });
    expect(parseJobTtlMs("100000")).toEqual({ value: 100_000 });
  });

  test.each([
    ["123junk", "trailing junk"],
    ["1.5", "fraction"],
    ["-1", "negative"],
    ["0", "below minimum"],
    ["59999", "just below minimum"],
    ["10800001", "just above maximum"],
    ["1e6", "exponent notation"],
    ["0x10", "hex"],
    [" 1", "leading whitespace"],
    ["1 ", "trailing whitespace"],
    ["+1", "sign prefix"],
    ["", "empty (covered above)"],
  ])("rejects %s (%s) with the typed error", (raw, _label) => {
    const result = parseJobTtlMs(raw);
    if (raw === "") {
      expect(result).toBeUndefined();
      return;
    }
    expect(result).toEqual({
      error: `SHELL_JOB_TTL_MS must be a canonical decimal integer between ${MIN} and ${MAX}.`,
    });
  });

  test("does not silently clamp — boundary inputs return the parsed value, not the minimum", () => {
    // The original bug: `123junk` would resolve to NaN and then clamp to
    // MIN_JOB_TTL_MS. The fix forces a typed error instead.
    expect(parseJobTtlMs("123junk")).toEqual({
      error: expect.stringContaining("must be a canonical decimal integer"),
    });
    expect(parseJobTtlMs("1")).toEqual({
      error: expect.stringContaining("must be a canonical decimal integer"),
    });
  });
});
