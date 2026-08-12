/**
 * Deterministic coverage for audit-views-soak timing env validation: pure
 * parsers, resolve helpers, and real CLI boundary rejection before Chromium
 * or the /api/views fetch is reached.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_NAV_WAIT_MS,
  DEFAULT_ROUNDS,
  MAX_TIMER_DELAY_MS,
  parsePositiveSafeInteger,
  resolveSoakTiming,
} from "./audit-views-soak.mjs";

const SCRIPT = fileURLToPath(
  new URL("./audit-views-soak.mjs", import.meta.url),
);
const NODE_BIN = process.execPath;

function runCli(env = {}, timeoutMs = 8_000) {
  return spawnSync(NODE_BIN, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  });
}

describe("parsePositiveSafeInteger", () => {
  it("accepts complete positive safe-integer decimals", () => {
    expect(parsePositiveSafeInteger("6", "ROUNDS")).toBe(6);
    expect(parsePositiveSafeInteger(700, "NAV_WAIT_MS")).toBe(700);
    expect(parsePositiveSafeInteger("1", "ROUNDS")).toBe(1);
  });

  it("rejects partial, signed, fractional, zero, and out-of-range values", () => {
    for (const value of [
      "",
      "  ",
      "abc",
      "6junk",
      "1.5",
      "+3",
      "-1",
      "0",
      Number.NaN,
      1.5,
      -1,
    ]) {
      expect(() => parsePositiveSafeInteger(value, "ROUNDS")).toThrow(
        /ROUNDS must be a positive safe-integer decimal/,
      );
    }
    expect(() =>
      parsePositiveSafeInteger(String(MAX_TIMER_DELAY_MS + 1), "NAV_WAIT_MS", {
        max: MAX_TIMER_DELAY_MS,
      }),
    ).toThrow(/NAV_WAIT_MS must be a positive safe-integer decimal/);
  });
});

describe("resolveSoakTiming", () => {
  it("keeps historical defaults when env is unset or blank", () => {
    expect(resolveSoakTiming({})).toEqual({
      rounds: DEFAULT_ROUNDS,
      navWaitMs: DEFAULT_NAV_WAIT_MS,
      navTimeoutMs: DEFAULT_NAV_TIMEOUT_MS,
    });
    expect(
      resolveSoakTiming({
        ROUNDS: "",
        NAV_WAIT_MS: "   ",
        NAV_TIMEOUT_MS: "",
      }),
    ).toEqual({
      rounds: DEFAULT_ROUNDS,
      navWaitMs: DEFAULT_NAV_WAIT_MS,
      navTimeoutMs: DEFAULT_NAV_TIMEOUT_MS,
    });
  });

  it("applies valid overrides", () => {
    expect(
      resolveSoakTiming({
        ROUNDS: "3",
        NAV_WAIT_MS: "500",
        NAV_TIMEOUT_MS: "12000",
      }),
    ).toEqual({ rounds: 3, navWaitMs: 500, navTimeoutMs: 12_000 });
  });

  it("fails closed on malformed ROUNDS, NAV_WAIT_MS, or NAV_TIMEOUT_MS", () => {
    expect(() => resolveSoakTiming({ ROUNDS: "6junk" })).toThrow(/ROUNDS/);
    expect(() => resolveSoakTiming({ ROUNDS: "0" })).toThrow(/ROUNDS/);
    expect(() => resolveSoakTiming({ NAV_WAIT_MS: "1.5" })).toThrow(
      /NAV_WAIT_MS/,
    );
    expect(() => resolveSoakTiming({ NAV_TIMEOUT_MS: "10s" })).toThrow(
      /NAV_TIMEOUT_MS/,
    );
    expect(() =>
      resolveSoakTiming({
        NAV_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS + 1),
      }),
    ).toThrow(/NAV_TIMEOUT_MS/);
  });
});

describe("audit-views-soak CLI boundary", () => {
  it("rejects invalid ROUNDS before soak work starts", () => {
    const result = runCli({ ROUNDS: "6junk" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ROUNDS/);
    expect(result.stdout + result.stderr).not.toMatch(/audit:views soak/);
    expect(result.stdout + result.stderr).not.toMatch(/\/api\/views/);
  });

  it("rejects invalid NAV_TIMEOUT_MS before soak work starts", () => {
    const result = runCli({ NAV_TIMEOUT_MS: "1.5" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/NAV_TIMEOUT_MS/);
    expect(result.stdout + result.stderr).not.toMatch(/audit:views soak/);
  });

  it("rejects zero ROUNDS instead of silently running zero churn", () => {
    const result = runCli({ ROUNDS: "0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ROUNDS/);
  });
});
