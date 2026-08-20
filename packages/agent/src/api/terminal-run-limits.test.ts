/**
 * Unit coverage for resolveTerminalRunLimits — env-driven concurrency and
 * duration guardrails with clamping to defaults and hard caps.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const ORIG_ENV = { ...process.env };

// Mock @elizaos/shared's parseClampedInteger: fallback for unset, clamp to
// [min, max], throw/fallback on non-integer. Mirror the real contract.
vi.mock("@elizaos/shared", () => {
  const parseClampedInteger = (
    raw: string | undefined,
    opts: { fallback: number; min: number; max: number },
  ): number => {
    if (raw === undefined || raw.trim() === "") return opts.fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return opts.fallback;
    return Math.min(opts.max, Math.max(opts.min, n));
  };
  return { parseClampedInteger };
});

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

  it("falls back to defaults on empty string input", () => {
    process.env.ELIZA_TERMINAL_MAX_CONCURRENT = "";
    process.env.ELIZA_TERMINAL_MAX_DURATION_MS = "";
    const r = resolveTerminalRunLimits();
    expect(r.maxConcurrent).toBe(2);
    expect(r.maxDurationMs).toBe(5 * 60 * 1000);
  });
});
