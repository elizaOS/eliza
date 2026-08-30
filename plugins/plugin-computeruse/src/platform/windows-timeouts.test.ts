/** Verifies the PowerShell timeout-floor contract at its environment boundary. */

import { afterEach, describe, expect, it } from "vitest";
import { PS_SPAWN_TIMEOUT_ENV, psSpawnTimeoutMs } from "./windows-timeouts";

describe("psSpawnTimeoutMs", () => {
  afterEach(() => {
    delete process.env[PS_SPAWN_TIMEOUT_ENV];
  });

  it("returns the base budget when the env floor is unset", () => {
    expect(psSpawnTimeoutMs(5_000)).toBe(5_000);
  });

  it("raises the budget to the env floor when it is above the base", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "30000";
    expect(psSpawnTimeoutMs(5_000)).toBe(30_000);
  });

  it("never lowers the budget when the env floor is below the base", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "1000";
    expect(psSpawnTimeoutMs(5_000)).toBe(5_000);
  });

  it("treats a floor equal to the base as a no-op", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "5000";
    expect(psSpawnTimeoutMs(5_000)).toBe(5_000);
  });

  it("ignores non-numeric values", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "definitely-not-a-number";
    expect(psSpawnTimeoutMs(5_000)).toBe(5_000);
  });

  it("ignores non-positive and negative values", () => {
    for (const raw of ["0", "-1", "-5000"]) {
      process.env[PS_SPAWN_TIMEOUT_ENV] = raw;
      expect(psSpawnTimeoutMs(5_000)).toBe(5_000);
    }
  });

  it("ignores blank and whitespace-only values", () => {
    for (const raw of ["", "   "]) {
      process.env[PS_SPAWN_TIMEOUT_ENV] = raw;
      expect(psSpawnTimeoutMs(5_000)).toBe(5_000);
    }
  });

  it("parses whitespace-padded positive integers", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "  15000  ";
    expect(psSpawnTimeoutMs(5_000)).toBe(15_000);
  });

  it("parses the leading integer portion of decimal strings", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "12.5";
    expect(psSpawnTimeoutMs(5)).toBe(12);
  });

  it("parses a leading integer run from partially-numeric strings", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "12abc";
    expect(psSpawnTimeoutMs(5)).toBe(12);
  });

  it("treats a huge floor as capped to the parsed value", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "9007199254740993";
    expect(psSpawnTimeoutMs(5_000)).toBe(
      Number.parseInt("9007199254740993", 10),
    );
  });
});
