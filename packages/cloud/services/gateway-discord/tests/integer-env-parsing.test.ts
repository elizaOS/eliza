/**
 * Exercises the shared integer lexical and gateway range boundaries with
 * deterministic environment data and no process-global module cache.
 */
import { describe, expect, test } from "bun:test";
import { parseIntegerEnv, parseIntegerEnvAtLeast } from "../src/integer-env";

describe("gateway-discord integer env parsing", () => {
  test("the shared lexical boundary accepts complete signed integers only", () => {
    const name = "TEST_INTEGER";
    expect(parseIntegerEnv(name, 17, {})).toBe(17);
    expect(parseIntegerEnv(name, 17, { [name]: "+3600" })).toBe(3600);
    expect(parseIntegerEnv(name, 17, { [name]: "-3600" })).toBe(-3600);
    expect(
      parseIntegerEnv(name, 17, { [name]: String(Number.MAX_SAFE_INTEGER) }),
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseIntegerEnv(name, 17, { [name]: "3600junk" })).toThrow(
      "is not a valid integer",
    );
    expect(() =>
      parseIntegerEnv(name, 17, {
        [name]: String(Number.MAX_SAFE_INTEGER + 1),
      }),
    ).toThrow("is not a valid integer");
  });

  test("the gateway range boundary remains separate from lexical validation", () => {
    const name = "ELIZA_APP_DM_POLL_INTERVAL_MS";
    expect(parseIntegerEnvAtLeast(name, 2_000, 500, {})).toBe(2_000);
    expect(parseIntegerEnvAtLeast(name, 2_000, 500, { [name]: "+500" })).toBe(
      500,
    );
    expect(() =>
      parseIntegerEnvAtLeast(name, 2_000, 500, { [name]: "499" }),
    ).toThrow("below minimum value of 500");
  });
});
