/**
 * Direct unit coverage for the app-core CLI process-global verbose/yes flags
 * and gated verbose logger. Drives the real module: flag round-trips, the
 * LOG_LEVEL OR-gate (including unknown and case-folded levels), logger.debug
 * plus muted stdout when `--verbose` is on, logger-only output when only the
 * log-level threshold is met, and the logger-throw path that must not block
 * stdout. Spies observe logger and console side effects; they do not replace
 * the module under test.
 */
import { logger } from "@elizaos/core";
import { theme } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isVerbose,
  isYes,
  logVerbose,
  setVerbose,
  setYes,
  shouldLogVerbose,
} from "../globals.ts";

const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL;

function setLogLevel(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = value;
  }
}

function restoreLogLevel(): void {
  if (ORIGINAL_LOG_LEVEL === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL;
  }
}

describe("globals verbose/yes state", () => {
  beforeEach(() => {
    setVerbose(false);
    setYes(false);
    setLogLevel("info");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setVerbose(false);
    setYes(false);
    restoreLogLevel();
  });

  it("tracks the verbose flag", () => {
    expect(isVerbose()).toBe(false);
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    setVerbose(false);
    expect(isVerbose()).toBe(false);
  });

  it("tracks the yes flag", () => {
    expect(isYes()).toBe(false);
    setYes(true);
    expect(isYes()).toBe(true);
    setYes(false);
    expect(isYes()).toBe(false);
  });

  it("keeps verbose and yes flags independent", () => {
    setVerbose(true);
    expect(isYes()).toBe(false);
    setYes(true);
    expect(isVerbose()).toBe(true);
    setVerbose(false);
    expect(isYes()).toBe(true);
  });

  it("shouldLogVerbose is true when verbose is set", () => {
    setVerbose(true);
    expect(shouldLogVerbose()).toBe(true);
  });

  it("shouldLogVerbose is false at default info when verbose is off", () => {
    expect(shouldLogVerbose()).toBe(false);
  });

  it("shouldLogVerbose is false when LOG_LEVEL is unset", () => {
    setLogLevel(undefined);
    expect(shouldLogVerbose()).toBe(false);
  });

  it.each(["warn", "error", "fatal", "silent"] as const)(
    "shouldLogVerbose is false at LOG_LEVEL=%s when verbose is off",
    (level) => {
      setLogLevel(level);
      expect(shouldLogVerbose()).toBe(false);
    },
  );

  it.each(["debug", "trace"] as const)(
    "shouldLogVerbose is true at LOG_LEVEL=%s even when verbose is off",
    (level) => {
      setLogLevel(level);
      expect(shouldLogVerbose()).toBe(true);
    },
  );

  it("treats an unknown LOG_LEVEL as info, so debug is not enabled", () => {
    setLogLevel("not-a-level");
    expect(shouldLogVerbose()).toBe(false);
  });

  it("folds LOG_LEVEL case so DEBUG enables verbose logging", () => {
    setLogLevel("DEBUG");
    expect(shouldLogVerbose()).toBe(true);
  });

  it("logVerbose is a no-op when not verbose and LOG_LEVEL is info", () => {
    const debug = vi.spyOn(logger, "debug");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logVerbose("secret");
    expect(debug).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("writes logger.debug and muted stdout when verbose is on", () => {
    setVerbose(true);
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logVerbose("hello verbose");
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith({ message: "hello verbose" }, "verbose");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(theme.muted("hello verbose"));
  });

  it("logs to the structured logger but not stdout when only LOG_LEVEL is debug", () => {
    setLogLevel("debug");
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logVerbose("level only");
    expect(debug).toHaveBeenCalledWith({ message: "level only" }, "verbose");
    expect(log).not.toHaveBeenCalled();
  });

  it("still prints muted stdout when logger.debug throws under --verbose", () => {
    setVerbose(true);
    vi.spyOn(logger, "debug").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => logVerbose("keep printing")).not.toThrow();
    expect(log).toHaveBeenCalledWith(theme.muted("keep printing"));
  });

  it("swallows logger.debug failures without printing when verbose is off", () => {
    setLogLevel("debug");
    vi.spyOn(logger, "debug").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => logVerbose("no stdout")).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});
