/** Verifies shell startup diagnostics and invalid-directory failures at the configuration boundary. */
import path from "node:path";
import { logger } from "@elizaos/core";
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

  it.each([
    ["SHELL_TIMEOUT", "1oops"],
    ["SHELL_MAX_OUTPUT_CHARS", "1e3"],
    ["SHELL_PENDING_MAX_OUTPUT_CHARS", " 200000"],
    ["SHELL_BACKGROUND_MS", "9007199254740992"],
  ])("rejects malformed positive integer %s values", (name, value) => {
    vi.stubEnv(name, value);

    expect(() => loadShellConfig()).toThrow(
      `Shell plugin configuration error: ${name} must be a positive decimal integer`,
    );
  });

  it("preserves valid decimal values across every numeric setting", () => {
    vi.stubEnv("SHELL_TIMEOUT", "45000");
    vi.stubEnv("SHELL_MAX_OUTPUT_CHARS", "250000");
    vi.stubEnv("SHELL_PENDING_MAX_OUTPUT_CHARS", "150000");
    vi.stubEnv("SHELL_BACKGROUND_MS", "12000");

    expect(loadShellConfig()).toMatchObject({
      timeout: 45000,
      maxOutputChars: 250000,
      pendingMaxOutputChars: 150000,
      defaultBackgroundMs: 12000,
    });
  });

  it.each(["0", "-1"])(
    "continues to reject non-positive timeout %s",
    (value) => {
      vi.stubEnv("SHELL_TIMEOUT", value);

      expect(() => loadShellConfig()).toThrow(
        "Shell plugin configuration error: SHELL_TIMEOUT must be a positive decimal integer",
      );
    },
  );

  it("rejects timeout values above Node's maximum timer delay", () => {
    vi.stubEnv("SHELL_TIMEOUT", "2147483648");

    expect(() => loadShellConfig()).toThrow(
      "Shell plugin configuration error: SHELL_TIMEOUT must be a positive decimal integer no greater than 2147483647",
    );
  });
});
