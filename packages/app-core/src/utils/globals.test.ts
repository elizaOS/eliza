/**
 * Tests for globals — process-global CLI flags and verbose logger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isVerbose,
  isYes,
  logVerbose,
  setVerbose,
  setYes,
  shouldLogVerbose,
} from "./globals.ts";

describe("globals", () => {
  beforeEach(() => {
    setVerbose(false);
    setYes(false);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setVerbose(false);
    setYes(false);
    delete process.env.LOG_LEVEL;
  });

  it("setVerbose and isVerbose", () => {
    expect(isVerbose()).toBe(false);
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    setVerbose(false);
    expect(isVerbose()).toBe(false);
  });

  it("setYes and isYes", () => {
    expect(isYes()).toBe(false);
    setYes(true);
    expect(isYes()).toBe(true);
    setYes(false);
    expect(isYes()).toBe(false);
  });

  it("shouldLogVerbose respects verbose flag", () => {
    setVerbose(true);
    expect(shouldLogVerbose()).toBe(true);
    setVerbose(false);
    process.env.LOG_LEVEL = "info";
    expect(shouldLogVerbose()).toBe(false);
    process.env.LOG_LEVEL = "debug";
    expect(shouldLogVerbose()).toBe(true);
  });

  it("shouldLogVerbose respects LOG_LEVEL trace", () => {
    setVerbose(false);
    process.env.LOG_LEVEL = "trace";
    expect(shouldLogVerbose()).toBe(true);
    process.env.LOG_LEVEL = "silent";
    expect(shouldLogVerbose()).toBe(false);
  });

  it("logVerbose does not throw when verbose off", () => {
    setVerbose(false);
    process.env.LOG_LEVEL = "info";
    expect(() => logVerbose("hello")).not.toThrow();
  });

  it("logVerbose logs when verbose on", () => {
    setVerbose(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logVerbose("test message");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
