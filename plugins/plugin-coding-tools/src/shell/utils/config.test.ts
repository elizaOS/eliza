/**
 * Verifies shell startup diagnostics, invalid-directory failures, and the
 * strict numeric-setting boundary (#18988): each explicit token must be an
 * exact in-range positive decimal integer, rejected with a typed ElizaError
 * before any service state exists; unset and blank fall back to defaults.
 */
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadShellConfig } from "./config.js";

describe("loadShellConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps successful security-relevant configuration at debug level", () => {
    const debugSpy = vi
      .spyOn(logger, "debug")
      .mockImplementation(() => undefined);
    const infoSpy = vi
      .spyOn(logger, "info")
      .mockImplementation(() => undefined);
    vi.stubEnv("SHELL_ALLOWED_DIRECTORY", process.cwd());
    vi.stubEnv("SHELL_ALLOW_BACKGROUND", "false");
    vi.stubEnv("SHELL_TIMEOUT", "45000");

    const config = loadShellConfig();

    expect(config.allowedDirectory).toBe(path.resolve(process.cwd()));
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Shell plugin enabled with allowed directory: ${config.allowedDirectory}, background: false, timeout: 45000ms`,
      ),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Shell plugin enabled with allowed directory:"),
    );
  });

  it("still throws an explicit error for a missing allowed directory", () => {
    const missingDirectory = path.join(
      process.cwd(),
      "__missing-shell-config-test-directory__",
    );
    vi.stubEnv("SHELL_ALLOWED_DIRECTORY", missingDirectory);

    expect(() => loadShellConfig()).toThrow(
      `SHELL_ALLOWED_DIRECTORY does not exist: ${missingDirectory}`,
    );
  });
});

describe("strictly bounded numeric shell settings (#18988)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function expectConfigError(setting: string, value: string) {
    vi.stubEnv("SHELL_ALLOWED_DIRECTORY", process.cwd());
    vi.stubEnv(setting, value);
    let thrown: unknown;
    try {
      loadShellConfig();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    const typed = thrown as ElizaError;
    expect(typed.code).toBe("SHELL_CONFIG_INVALID");
    expect(typed.context).toMatchObject({ setting, value });
    expect(typed.message).toContain(setting);
    expect(typed.message).toMatch(/between \d+ and \d+/);
    vi.unstubAllEnvs();
  }

  it("unset and blank tokens preserve every documented default", () => {
    vi.stubEnv("SHELL_ALLOWED_DIRECTORY", process.cwd());
    vi.stubEnv("SHELL_TIMEOUT", "");
    vi.stubEnv("SHELL_BACKGROUND_MS", "   ");

    const config = loadShellConfig();

    expect(config.timeout).toBe(30000);
    expect(config.maxOutputChars).toBe(200000);
    expect(config.pendingMaxOutputChars).toBe(200000);
    expect(config.defaultBackgroundMs).toBe(10000);
  });

  it("accepts documented ordinary values and exact range boundaries", () => {
    vi.stubEnv("SHELL_ALLOWED_DIRECTORY", process.cwd());
    vi.stubEnv("SHELL_TIMEOUT", "2147483647");
    vi.stubEnv("SHELL_MAX_OUTPUT_CHARS", "10000000");
    vi.stubEnv("SHELL_PENDING_MAX_OUTPUT_CHARS", "1");
    vi.stubEnv("SHELL_BACKGROUND_MS", "120000");

    const upper = loadShellConfig();
    expect(upper.timeout).toBe(2_147_483_647);
    expect(upper.maxOutputChars).toBe(10_000_000);
    expect(upper.pendingMaxOutputChars).toBe(1);
    expect(upper.defaultBackgroundMs).toBe(120_000);

    vi.stubEnv("SHELL_TIMEOUT", "45000");
    vi.stubEnv("SHELL_MAX_OUTPUT_CHARS", "200000");
    vi.stubEnv("SHELL_PENDING_MAX_OUTPUT_CHARS", "200000");
    vi.stubEnv("SHELL_BACKGROUND_MS", "10");

    const ordinary = loadShellConfig();
    expect(ordinary.timeout).toBe(45000);
    expect(ordinary.maxOutputChars).toBe(200000);
    expect(ordinary.defaultBackgroundMs).toBe(10);
  });

  it("rejects malformed tokens that parseInt silently truncated", () => {
    expectConfigError("SHELL_TIMEOUT", "100abc");
    expectConfigError("SHELL_TIMEOUT", "1e10");
    expectConfigError("SHELL_TIMEOUT", "junk");
    expectConfigError("SHELL_MAX_OUTPUT_CHARS", "1.5");
    expectConfigError("SHELL_BACKGROUND_MS", "+500");
    expectConfigError("SHELL_BACKGROUND_MS", "-500");
  });

  it("rejects below-range values instead of passing them live", () => {
    expectConfigError("SHELL_TIMEOUT", "0");
    expectConfigError("SHELL_MAX_OUTPUT_CHARS", "0");
    expectConfigError("SHELL_BACKGROUND_MS", "9");
  });

  it("rejects above-ceiling values instead of overflowing or clamping", () => {
    // setTimeout ceiling: 2^31 would overflow and fire the kill timer
    // immediately.
    expectConfigError("SHELL_TIMEOUT", "2147483648");
    // Retained output beyond the per-session ceiling would defeat the
    // memory cap even though it is a safe integer.
    expectConfigError("SHELL_MAX_OUTPUT_CHARS", "10000001");
    expectConfigError("SHELL_PENDING_MAX_OUTPUT_CHARS", "9007199254740991");
    // The yield-window consumer clamps to 120000ms; a larger configured
    // default must be rejected, not silently rewritten per call.
    expectConfigError("SHELL_BACKGROUND_MS", "120001");
  });
});
