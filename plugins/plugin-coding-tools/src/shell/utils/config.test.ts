/** Verifies typed shell configuration failures, live numeric bounds, defaults, and startup diagnostics. */
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellService } from "../services/shellService.js";
import { loadShellConfig } from "./config.js";

function captureConfigError(): ElizaError {
  try {
    loadShellConfig();
  } catch (error) {
    // error-policy:J3 the test captures the explicit invalid-config result so
    // it can assert the typed classification and structured boundary context.
    expect(error).toBeInstanceOf(ElizaError);
    return error as ElizaError;
  }
  throw new Error("Expected loadShellConfig to reject invalid configuration");
}

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

  it("uses the sole coding workspace root when no shell directory is explicit", () => {
    vi.stubEnv("SHELL_ALLOWED_DIRECTORY", "");
    vi.stubEnv("ELIZA_WORKSPACE_DIR", "");
    vi.stubEnv("CODING_TOOLS_WORKSPACE_ROOTS", process.cwd());

    expect(loadShellConfig().allowedDirectory).toBe(
      path.resolve(process.cwd()),
    );
  });

  it("prefers the explicit Eliza workspace over coding roots", () => {
    vi.stubEnv("SHELL_ALLOWED_DIRECTORY", "");
    vi.stubEnv("ELIZA_WORKSPACE_DIR", process.cwd());
    vi.stubEnv(
      "CODING_TOOLS_WORKSPACE_ROOTS",
      path.join(process.cwd(), "not-the-active-workspace"),
    );

    expect(loadShellConfig().allowedDirectory).toBe(
      path.resolve(process.cwd()),
    );
  });

  it("still throws an explicit error for a missing allowed directory", () => {
    const missingDirectory = path.join(
      process.cwd(),
      "__missing-shell-config-test-directory__",
    );
    vi.stubEnv("SHELL_ALLOWED_DIRECTORY", missingDirectory);

    const error = captureConfigError();
    expect(error).toMatchObject({
      code: "SHELL_CONFIG_DIRECTORY_MISSING",
      context: { allowedDirectory: missingDirectory },
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
  });

  it.each([
    ["SHELL_TIMEOUT", "1oops", 1, 2_147_483_647],
    ["SHELL_MAX_OUTPUT_CHARS", "1e3", 1, 1_000_000],
    ["SHELL_PENDING_MAX_OUTPUT_CHARS", " 200000", 1, 1_000_000],
    ["SHELL_BACKGROUND_MS", "9007199254740992", 10, 120_000],
    ["SHELL_JOB_TTL_MS", "123junk", 60_000, 10_800_000],
    ["SHELL_JOB_TTL_MS", "1.5", 60_000, 10_800_000],
    ["SHELL_JOB_TTL_MS", "-1", 60_000, 10_800_000],
    ["SHELL_JOB_TTL_MS", " 60000", 60_000, 10_800_000],
    ["SHELL_JOB_TTL_MS", "060000", 60_000, 10_800_000],
    ["SHELL_JOB_TTL_MS", "1e6", 60_000, 10_800_000],
    ["SHELL_JOB_TTL_MS", "9007199254740992", 60_000, 10_800_000],
  ])(
    "rejects malformed positive integer %s values",
    (name, value, minimum, maximum) => {
      vi.stubEnv(name, value);

      const error = captureConfigError();
      expect(error).toMatchObject({
        code: "SHELL_CONFIG_INTEGER_INVALID",
        context: { setting: name, received: value, minimum, maximum },
        severity: "fatal",
      });
    },
  );

  it("preserves valid decimal values across every numeric setting", () => {
    vi.stubEnv("SHELL_TIMEOUT", "45000");
    vi.stubEnv("SHELL_MAX_OUTPUT_CHARS", "250000");
    vi.stubEnv("SHELL_PENDING_MAX_OUTPUT_CHARS", "150000");
    vi.stubEnv("SHELL_BACKGROUND_MS", "12000");
    vi.stubEnv("SHELL_JOB_TTL_MS", "3600000");

    expect(loadShellConfig()).toMatchObject({
      timeout: 45000,
      maxOutputChars: 250000,
      pendingMaxOutputChars: 150000,
      defaultBackgroundMs: 12000,
      jobTtlMs: 3_600_000,
    });
  });

  it("rejects malformed job TTL at the ShellService startup boundary", async () => {
    vi.stubEnv("SHELL_JOB_TTL_MS", "60000ms");

    await expect(ShellService.start({} as never)).rejects.toMatchObject({
      code: "SHELL_CONFIG_INTEGER_INVALID",
      context: {
        setting: "SHELL_JOB_TTL_MS",
        received: "60000ms",
        minimum: 60_000,
        maximum: 10_800_000,
      },
      severity: "fatal",
    });
  });

  it("applies a valid job TTL at the ShellService startup boundary", async () => {
    vi.stubEnv("SHELL_JOB_TTL_MS", "60000");

    const service = await ShellService.start({} as never);
    expect(service.getShellConfig().jobTtlMs).toBe(60_000);
    await service.stop();
  });

  it.each(["0", "-1"])(
    "continues to reject non-positive timeout %s",
    (value) => {
      vi.stubEnv("SHELL_TIMEOUT", value);

      expect(captureConfigError().message).toBe(
        "Shell plugin configuration error: SHELL_TIMEOUT must be a positive decimal integer no greater than 2147483647",
      );
    },
  );

  it.each([
    ["SHELL_TIMEOUT", "2147483648", 1, 2_147_483_647],
    ["SHELL_MAX_OUTPUT_CHARS", "1000001", 1, 1_000_000],
    ["SHELL_PENDING_MAX_OUTPUT_CHARS", "1000001", 1, 1_000_000],
    ["SHELL_BACKGROUND_MS", "9", 10, 120_000],
    ["SHELL_BACKGROUND_MS", "120001", 10, 120_000],
    ["SHELL_JOB_TTL_MS", "59999", 60_000, 10_800_000],
    ["SHELL_JOB_TTL_MS", "10800001", 60_000, 10_800_000],
  ])("rejects out-of-range %s=%s", (name, value, minimum, maximum) => {
    vi.stubEnv(name, value);

    expect(captureConfigError()).toMatchObject({
      code: "SHELL_CONFIG_INTEGER_INVALID",
      context: { setting: name, received: value, minimum, maximum },
    });
  });

  it("accepts every numeric setting at its live boundary", () => {
    vi.stubEnv("SHELL_TIMEOUT", "2147483647");
    vi.stubEnv("SHELL_MAX_OUTPUT_CHARS", "1000000");
    vi.stubEnv("SHELL_PENDING_MAX_OUTPUT_CHARS", "1");
    vi.stubEnv("SHELL_BACKGROUND_MS", "120000");
    vi.stubEnv("SHELL_JOB_TTL_MS", "10800000");

    expect(loadShellConfig()).toMatchObject({
      timeout: 2_147_483_647,
      maxOutputChars: 1_000_000,
      pendingMaxOutputChars: 1,
      defaultBackgroundMs: 120_000,
      jobTtlMs: 10_800_000,
    });
  });

  it("uses the documented job TTL default when unset or blank", () => {
    expect(loadShellConfig().jobTtlMs).toBe(1_800_000);

    vi.stubEnv("SHELL_JOB_TTL_MS", "");
    expect(loadShellConfig().jobTtlMs).toBe(1_800_000);
  });
});
