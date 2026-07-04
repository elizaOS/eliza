/**
 * psSpawnTimeoutMs env-override and floor behavior for Windows PowerShell spawns.
 * Deterministic unit test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PS_SPAWN_TIMEOUT_ENV,
  psSpawnTimeoutMs,
} from "../platform/windows-timeouts.js";

describe("psSpawnTimeoutMs", () => {
  const original = process.env[PS_SPAWN_TIMEOUT_ENV];

  beforeEach(() => {
    delete process.env[PS_SPAWN_TIMEOUT_ENV];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[PS_SPAWN_TIMEOUT_ENV];
    else process.env[PS_SPAWN_TIMEOUT_ENV] = original;
  });

  it("returns the base budget when the env var is unset", () => {
    expect(psSpawnTimeoutMs(15000)).toBe(15000);
  });

  it("raises the base to the env floor when the floor is higher", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "30000";
    expect(psSpawnTimeoutMs(15000)).toBe(30000);
    expect(psSpawnTimeoutMs(5000)).toBe(30000);
  });

  it("never lowers a base below the env floor", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "5000";
    // base already above the floor — the floor must not tighten it
    expect(psSpawnTimeoutMs(15000)).toBe(15000);
  });

  it("ignores a non-numeric env value", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "soon";
    expect(psSpawnTimeoutMs(15000)).toBe(15000);
  });

  it("ignores a non-positive env value", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "0";
    expect(psSpawnTimeoutMs(15000)).toBe(15000);
    process.env[PS_SPAWN_TIMEOUT_ENV] = "-1000";
    expect(psSpawnTimeoutMs(15000)).toBe(15000);
  });

  it("trims surrounding whitespace before parsing", () => {
    process.env[PS_SPAWN_TIMEOUT_ENV] = "  20000  ";
    expect(psSpawnTimeoutMs(15000)).toBe(20000);
  });
});
