/**
 * Deterministic coverage for dev-startup-smoke timing env validation: pure
 * parsers, resolve helpers, and real CLI boundary rejection before `bun run
 * dev` is ever spawned.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_MS,
  DEFAULT_HARD_KILL_MS,
  MAX_TIMER_DELAY_MS,
  parsePositiveSafeInteger,
  resolveStartupSmokeTiming,
} from "./dev-startup-smoke.mjs";

const SCRIPT = fileURLToPath(
  new URL("./dev-startup-smoke.mjs", import.meta.url),
);
const NODE_BIN = process.execPath;

function runCli(env = {}, timeoutMs = 5_000) {
  return spawnSync(NODE_BIN, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  });
}

describe("parsePositiveSafeInteger", () => {
  it("accepts complete positive safe-integer decimals", () => {
    expect(parsePositiveSafeInteger("60000", "budget")).toBe(60_000);
    expect(parsePositiveSafeInteger(8_000, "hard-kill")).toBe(8_000);
    expect(parsePositiveSafeInteger("1", "budget")).toBe(1);
  });

  it("rejects partial, signed, fractional, zero, and out-of-range values", () => {
    for (const value of [
      "",
      "  ",
      "abc",
      "60junk",
      "1.5",
      "+1000",
      "-3",
      "0",
      NaN,
      1.5,
      -1,
    ]) {
      expect(() => parsePositiveSafeInteger(value, "budget")).toThrow(
        /budget must be a positive safe-integer decimal/,
      );
    }
    expect(() =>
      parsePositiveSafeInteger(String(MAX_TIMER_DELAY_MS + 1), "hard-kill", {
        max: MAX_TIMER_DELAY_MS,
      }),
    ).toThrow(/hard-kill must be a positive safe-integer decimal/);
  });
});

describe("resolveStartupSmokeTiming", () => {
  it("keeps historical defaults when env is unset or blank", () => {
    expect(resolveStartupSmokeTiming({})).toEqual({
      budgetMs: DEFAULT_BUDGET_MS,
      hardKillMs: DEFAULT_HARD_KILL_MS,
    });
    expect(
      resolveStartupSmokeTiming({
        ELIZA_DEV_STARTUP_BUDGET_MS: "",
        ELIZA_DEV_STARTUP_HARD_KILL_MS: "   ",
      }),
    ).toEqual({
      budgetMs: DEFAULT_BUDGET_MS,
      hardKillMs: DEFAULT_HARD_KILL_MS,
    });
  });

  it("applies valid overrides", () => {
    expect(
      resolveStartupSmokeTiming({
        ELIZA_DEV_STARTUP_BUDGET_MS: "45000",
        ELIZA_DEV_STARTUP_HARD_KILL_MS: "2500",
      }),
    ).toEqual({ budgetMs: 45_000, hardKillMs: 2_500 });
  });

  it("fails closed on malformed budget or hard-kill overrides", () => {
    expect(() =>
      resolveStartupSmokeTiming({
        ELIZA_DEV_STARTUP_BUDGET_MS: "60junk",
      }),
    ).toThrow(/ELIZA_DEV_STARTUP_BUDGET_MS/);
    expect(() =>
      resolveStartupSmokeTiming({
        ELIZA_DEV_STARTUP_HARD_KILL_MS: "1.5",
      }),
    ).toThrow(/ELIZA_DEV_STARTUP_HARD_KILL_MS/);
    expect(() =>
      resolveStartupSmokeTiming({
        ELIZA_DEV_STARTUP_BUDGET_MS: "0",
      }),
    ).toThrow(/ELIZA_DEV_STARTUP_BUDGET_MS/);
    expect(() =>
      resolveStartupSmokeTiming({
        ELIZA_DEV_STARTUP_HARD_KILL_MS: String(MAX_TIMER_DELAY_MS + 1),
      }),
    ).toThrow(/ELIZA_DEV_STARTUP_HARD_KILL_MS/);
  });
});

describe("dev-startup-smoke CLI boundary", () => {
  it("rejects invalid budget env before spawning the dev stack", () => {
    const result = runCli({ ELIZA_DEV_STARTUP_BUDGET_MS: "60junk" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ELIZA_DEV_STARTUP_BUDGET_MS/);
    expect(result.stdout + result.stderr).not.toMatch(
      /\[dev-startup-smoke\] budget=/,
    );
    expect(result.stdout + result.stderr).not.toMatch(/process spawned/);
  });

  it("rejects invalid hard-kill env before spawning the dev stack", () => {
    const result = runCli({ ELIZA_DEV_STARTUP_HARD_KILL_MS: "8s" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ELIZA_DEV_STARTUP_HARD_KILL_MS/);
    expect(result.stdout + result.stderr).not.toMatch(
      /\[dev-startup-smoke\] budget=/,
    );
  });

  it("rejects zero budget instead of hanging with a NaN/zero deadline", () => {
    const result = runCli({ ELIZA_DEV_STARTUP_BUDGET_MS: "0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ELIZA_DEV_STARTUP_BUDGET_MS/);
  });
});
