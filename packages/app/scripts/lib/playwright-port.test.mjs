/**
 * Deterministic unit tests for Playwright lane TCP-port parsing. Covers the
 * real exported helpers: accept path, default-when-unset, and every fail-closed
 * invalid override that must abort before webServer or baseURL wiring.
 */
import { describe, expect, it } from "bun:test";
import {
  MAX_TCP_PORT,
  MIN_TCP_PORT,
  parsePlaywrightPort,
  resolvePlaywrightPortEnv,
} from "./playwright-port.mjs";

describe("parsePlaywrightPort", () => {
  it("accepts canonical ports at the range boundaries", () => {
    expect(parsePlaywrightPort("1", "PORT")).toBe(1);
    expect(parsePlaywrightPort(String(MAX_TCP_PORT), "PORT")).toBe(
      MAX_TCP_PORT,
    );
    expect(parsePlaywrightPort("2138", "ELIZA_UI_SMOKE_PORT")).toBe(2138);
    expect(parsePlaywrightPort("31337", "ELIZA_UI_SMOKE_API_PORT")).toBe(31337);
  });

  it("trims surrounding whitespace from operator env interpolation", () => {
    expect(parsePlaywrightPort("  2138\n", "PORT")).toBe(2138);
  });

  it("rejects partial parses, fractions, signed values, and non-digits", () => {
    for (const bad of [
      "2138junk",
      "junk",
      "21.38",
      "-1",
      "+2138",
      "0x84a",
      "2e3",
      "1_000",
    ]) {
      expect(() => parsePlaywrightPort(bad, "PORT")).toThrow(
        /must be a TCP port integer from 1 to 65535/,
      );
    }
  });

  it("rejects zero, out-of-range, empty, and leading-zero padded values", () => {
    for (const bad of ["0", "65536", "999999", "", "   ", "01", "02138"]) {
      expect(() => parsePlaywrightPort(bad, "ELIZA_UI_SMOKE_PORT")).toThrow(
        /ELIZA_UI_SMOKE_PORT must be a TCP port integer/,
      );
    }
  });

  it("names the label in the error for preflight diagnostics", () => {
    expect(() => parsePlaywrightPort("abc", "ELIZA_HMR_UI_PORT")).toThrow(
      'ELIZA_HMR_UI_PORT must be a TCP port integer from 1 to 65535 (received "abc")',
    );
  });
});

describe("resolvePlaywrightPortEnv", () => {
  const DEFAULT = 2138;

  it("keeps the documented default when the env var is unset or empty", () => {
    expect(resolvePlaywrightPortEnv({}, "ELIZA_UI_SMOKE_PORT", DEFAULT)).toBe(
      DEFAULT,
    );
    expect(
      resolvePlaywrightPortEnv(
        { ELIZA_UI_SMOKE_PORT: "" },
        "ELIZA_UI_SMOKE_PORT",
        DEFAULT,
      ),
    ).toBe(DEFAULT);
    expect(
      resolvePlaywrightPortEnv(
        { ELIZA_UI_SMOKE_PORT: "   " },
        "ELIZA_UI_SMOKE_PORT",
        DEFAULT,
      ),
    ).toBe(DEFAULT);
  });

  it("accepts a valid explicit override", () => {
    expect(
      resolvePlaywrightPortEnv(
        { ELIZA_UI_SMOKE_PORT: "42138" },
        "ELIZA_UI_SMOKE_PORT",
        DEFAULT,
      ),
    ).toBe(42138);
  });

  it("fails closed on an explicit invalid override instead of falling back", () => {
    expect(() =>
      resolvePlaywrightPortEnv(
        { ELIZA_UI_SMOKE_API_PORT: "31337junk" },
        "ELIZA_UI_SMOKE_API_PORT",
        31337,
      ),
    ).toThrow(/ELIZA_UI_SMOKE_API_PORT/);
    expect(() =>
      resolvePlaywrightPortEnv(
        { ELIZA_DEV_SMOKE_API_PORT: "0" },
        "ELIZA_DEV_SMOKE_API_PORT",
        31337,
      ),
    ).toThrow(/ELIZA_DEV_SMOKE_API_PORT/);
    expect(() =>
      resolvePlaywrightPortEnv(
        { ELIZA_HMR_UI_PORT: String(MAX_TCP_PORT + 1) },
        "ELIZA_HMR_UI_PORT",
        42138,
      ),
    ).toThrow(/ELIZA_HMR_UI_PORT/);
  });

  it("exports the TCP range constants used by callers and docs", () => {
    expect(MIN_TCP_PORT).toBe(1);
    expect(MAX_TCP_PORT).toBe(65535);
  });
});
