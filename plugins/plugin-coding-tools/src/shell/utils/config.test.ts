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
});
