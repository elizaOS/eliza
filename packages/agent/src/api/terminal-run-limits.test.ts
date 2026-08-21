/**
 * Unit coverage for resolveTerminalRunLimits — env-driven concurrency and
 * duration guardrails with clamping to defaults and hard caps.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIG_ENV = { ...process.env };

import { resolveTerminalRunLimits } from "./terminal-run-limits.ts";

describe("resolveTerminalRunLimits", () => {
  beforeEach(() => {
    process.env = { ...ORIG_ENV };
    delete process.env.ELIZA_TERMINAL_MAX_CONCURRENT;
    delete process.env.ELIZA_TERMINAL_MAX_DURATION_MS;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("returns defaults when env vars are unset", () => {
    const r = resolveTerminalRunLimits();
    expect(r.maxConcurrent).toBe(2);
    expect(r.maxDurationMs).toBe(5 * 60 * 1000);
  });

  it("respects explicit values within range", () => {
    process.env.ELIZA_TERMINAL_MAX_CONCURRENT = "4";
    process.env.ELIZA_TERMINAL_MAX_DURATION_MS = "600000";
    const r = resolveTerminalRunLimits();
    expect(r.maxConcurrent).toBe(4);
    expect(r.maxDurationMs).toBe(600000);
  });

  it("uses the shared parser's canonical whitespace and sign handling", () => {
    process.env.ELIZA_TERMINAL_MAX_CONCURRENT = " +4 ";
    process.env.ELIZA_TERMINAL_MAX_DURATION_MS = " 600000 ";
    expect(resolveTerminalRunLimits()).toEqual({
      maxConcurrent: 4,
      maxDurationMs: 600000,
    });
  });

  it("clamps concurrency to the hard cap", () => {
    process.env.ELIZA_TERMINAL_MAX_CONCURRENT = "999";
    expect(resolveTerminalRunLimits().maxConcurrent).toBe(16);
  });

  it("clamps concurrency to the minimum", () => {
    process.env.ELIZA_TERMINAL_MAX_CONCURRENT = "0";
    expect(resolveTerminalRunLimits().maxConcurrent).toBe(1);
  });

  it("clamps duration to the hard cap", () => {
    process.env.ELIZA_TERMINAL_MAX_DURATION_MS = "999999999";
    expect(resolveTerminalRunLimits().maxDurationMs).toBe(60 * 60 * 1000);
  });

  it("clamps duration to the minimum", () => {
    process.env.ELIZA_TERMINAL_MAX_DURATION_MS = "100";
    expect(resolveTerminalRunLimits().maxDurationMs).toBe(1000);
  });

  it("falls back to defaults on non-numeric input", () => {
    process.env.ELIZA_TERMINAL_MAX_CONCURRENT = "abc";
    process.env.ELIZA_TERMINAL_MAX_DURATION_MS = "not-a-number";
    const r = resolveTerminalRunLimits();
    expect(r.maxConcurrent).toBe(2);
    expect(r.maxDurationMs).toBe(5 * 60 * 1000);
  });

  it("rejects non-canonical numeric forms and unsafe integers", () => {
    for (const value of ["1.5", "1e2", "0x10", "9007199254740993"]) {
      process.env.ELIZA_TERMINAL_MAX_CONCURRENT = value;
      process.env.ELIZA_TERMINAL_MAX_DURATION_MS = value;
      expect(resolveTerminalRunLimits()).toEqual({
        maxConcurrent: 2,
        maxDurationMs: 5 * 60 * 1000,
      });
    }
  });

  it("falls back to defaults on empty string input", () => {
    process.env.ELIZA_TERMINAL_MAX_CONCURRENT = "";
    process.env.ELIZA_TERMINAL_MAX_DURATION_MS = "";
    const r = resolveTerminalRunLimits();
    expect(r.maxConcurrent).toBe(2);
    expect(r.maxDurationMs).toBe(5 * 60 * 1000);
  });
});
