/**
 * Verifies the terminal verbose globals: the explicit verbose flag and the
 * LOG_LEVEL priority ladder gate debug output, a failing logger never breaks
 * callers, and the yes flag tracks state independently of verbosity.
 *
 * The real module under test drives every case; spies only observe the
 * logger and console boundaries. Module-level flags are reset before each
 * case so pass order never matters.
 */
import { logger } from "@elizaos/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { theme } from "../terminal/theme";
import {
  isVerbose,
  isYes,
  logVerbose,
  setVerbose,
  setYes,
  shouldLogVerbose,
} from "./globals";

const originalLogLevel = process.env.LOG_LEVEL;

beforeEach(() => {
  delete process.env.LOG_LEVEL;
  setVerbose(false);
  setYes(false);
});

afterEach(() => {
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
  vi.restoreAllMocks();
});

describe("verbose flag", () => {
  it("defaults to off", () => {
    expect(isVerbose()).toBe(false);
    expect(shouldLogVerbose()).toBe(false);
  });

  it("round-trips through setVerbose", () => {
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    expect(shouldLogVerbose()).toBe(true);

    setVerbose(false);
    expect(isVerbose()).toBe(false);
  });
});

describe("shouldLogVerbose LOG_LEVEL gating", () => {
  it.each(["trace", "debug", "DEBUG", "Trace"])(
    "enables verbose output when LOG_LEVEL=%s",
    (level) => {
      process.env.LOG_LEVEL = level;
      expect(shouldLogVerbose()).toBe(true);
    },
  );

  it.each(["info", "warn", "error", "fatal", "silent", "not-a-level"])(
    "keeps verbose output off when LOG_LEVEL=%s",
    (level) => {
      process.env.LOG_LEVEL = level;
      expect(shouldLogVerbose()).toBe(false);
    },
  );

  it("treats an unset LOG_LEVEL like info", () => {
    delete process.env.LOG_LEVEL;
    expect(shouldLogVerbose()).toBe(false);
  });

  it("lets the explicit verbose flag override a quiet LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "fatal";
    setVerbose(true);
    expect(shouldLogVerbose()).toBe(true);
  });
});

describe("logVerbose output routing", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("stays fully silent when verbose is off and LOG_LEVEL is quiet", () => {
    process.env.LOG_LEVEL = "info";

    logVerbose("hidden");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("routes through the structured logger but not the console when only LOG_LEVEL enables it", () => {
    process.env.LOG_LEVEL = "debug";

    logVerbose("env-only");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith({ message: "env-only" }, "verbose");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("adds muted console output only when the verbose flag is set", () => {
    setVerbose(true);

    logVerbose("flag-only");

    expect(debugSpy).toHaveBeenCalledWith({ message: "flag-only" }, "verbose");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(theme.muted("flag-only"));
  });

  it("survives a throwing logger and still prints once verbose is set", () => {
    setVerbose(true);
    debugSpy.mockImplementation(() => {
      throw new Error("logger backend exploded");
    });

    expect(() => logVerbose("resilient")).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(theme.muted("resilient"));
  });
});

describe("yes flag", () => {
  it("defaults to off and round-trips independently of verbosity", () => {
    expect(isYes()).toBe(false);

    setYes(true);
    setVerbose(true);
    expect(isYes()).toBe(true);
    expect(isVerbose()).toBe(true);

    setYes(false);
    expect(isYes()).toBe(false);
    expect(isVerbose()).toBe(true);
  });
});
