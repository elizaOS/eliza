/**
 * Loads and zod-validates the shell configuration from environment variables
 * into a ShellConfig, applying defaults and merging DEFAULT_FORBIDDEN_COMMANDS.
 * Throws when SHELL_ALLOWED_DIRECTORY is missing or does not exist on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { z } from "zod";
import type { ShellConfig } from "../types";

/**
 * Ceilings for the numeric shell settings, each tied to the real consumer of
 * the value rather than an arbitrary sanity number:
 * - timeout feeds a `setTimeout` (shellService kill timer), whose 32-bit
 *   signed ceiling is 2^31-1 ms — larger values overflow and fire immediately,
 *   turning "very long timeout" into "instant kill";
 * - the yield window consumer clamps to [10, 120_000] ms, so a configured
 *   default outside that window would be silently rewritten on every call;
 * - retained-output settings size in-memory per-session buffers, so they get
 *   a practical per-session ceiling instead of "any safe integer".
 */
const SHELL_TIMEOUT_MAX_MS = 2_147_483_647;
const SHELL_BACKGROUND_MIN_MS = 10;
const SHELL_BACKGROUND_MAX_MS = 120_000;
const SHELL_OUTPUT_CHARS_MAX = 10_000_000;

/**
 * Parses one explicitly-provided env token as an exact positive decimal
 * integer within [min, max]. Unset and blank both mean "use the default"
 * (blank-is-unset convention); anything else that is not exactly an in-range
 * decimal integer throws before any shell service state exists.
 */
function parseShellSetting(
  setting: string,
  raw: string | undefined,
  {
    defaultValue,
    min,
    max,
  }: { defaultValue: number; min: number; max: number },
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const token = raw.trim();
  const value = /^\d+$/.test(token) ? Number(token) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ElizaError(
      `${setting} must be an integer between ${min} and ${max}; received ${JSON.stringify(raw)}`,
      {
        code: "SHELL_CONFIG_INVALID",
        context: { setting, value: raw, min, max },
        severity: "fatal",
      },
    );
  }
  return value;
}

const configSchema = z.object({
  enabled: z.boolean(),
  allowedDirectory: z.string(),
  timeout: z.number().positive().default(30000),
  forbiddenCommands: z.array(z.string()),
  maxOutputChars: z.number().positive().default(200000),
  pendingMaxOutputChars: z.number().positive().default(200000),
  defaultBackgroundMs: z.number().positive().default(10000),
  allowBackground: z.boolean().default(true),
});

export const DEFAULT_FORBIDDEN_COMMANDS: readonly string[] = [
  "rm -rf /",
  "rmdir",
  "chmod 777",
  "chown",
  "chgrp",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "kill -9",
  "killall",
  "pkill",
  "sudo rm -rf",
  "su",
  "passwd",
  "useradd",
  "userdel",
  "groupadd",
  "groupdel",
  "format",
  "fdisk",
  "mkfs",
  "dd if=/dev/zero",
  "shred",
  ":(){:|:&};:",
] as const;

export function loadShellConfig(): ShellConfig {
  const allowedDirectory = process.env.SHELL_ALLOWED_DIRECTORY || process.cwd();
  const timeout = parseShellSetting(
    "SHELL_TIMEOUT",
    process.env.SHELL_TIMEOUT,
    {
      defaultValue: 30000,
      min: 1,
      max: SHELL_TIMEOUT_MAX_MS,
    },
  );
  const maxOutputChars = parseShellSetting(
    "SHELL_MAX_OUTPUT_CHARS",
    process.env.SHELL_MAX_OUTPUT_CHARS,
    { defaultValue: 200000, min: 1, max: SHELL_OUTPUT_CHARS_MAX },
  );
  const pendingMaxOutputChars = parseShellSetting(
    "SHELL_PENDING_MAX_OUTPUT_CHARS",
    process.env.SHELL_PENDING_MAX_OUTPUT_CHARS,
    { defaultValue: 200000, min: 1, max: SHELL_OUTPUT_CHARS_MAX },
  );
  const defaultBackgroundMs = parseShellSetting(
    "SHELL_BACKGROUND_MS",
    process.env.SHELL_BACKGROUND_MS,
    {
      defaultValue: 10000,
      min: SHELL_BACKGROUND_MIN_MS,
      max: SHELL_BACKGROUND_MAX_MS,
    },
  );
  const allowBackground = process.env.SHELL_ALLOW_BACKGROUND !== "false";

  const customForbidden = process.env.SHELL_FORBIDDEN_COMMANDS
    ? process.env.SHELL_FORBIDDEN_COMMANDS.split(",").map((cmd) => cmd.trim())
    : [];

  const forbiddenCommands = [
    ...new Set([...DEFAULT_FORBIDDEN_COMMANDS, ...customForbidden]),
  ];

  const config: ShellConfig = {
    enabled: true,
    allowedDirectory,
    timeout,
    forbiddenCommands,
    maxOutputChars,
    pendingMaxOutputChars,
    defaultBackgroundMs,
    allowBackground,
  };

  const parseResult = configSchema.safeParse(config);
  if (!parseResult.success) {
    const errorMessage =
      parseResult.error.issues[0]?.message || parseResult.error.toString();
    throw new Error(`Shell plugin configuration error: ${errorMessage}`);
  }

  try {
    const stats = fs.statSync(allowedDirectory);
    if (!stats.isDirectory()) {
      throw new Error(
        `SHELL_ALLOWED_DIRECTORY is not a directory: ${allowedDirectory}`,
      );
    }
    config.allowedDirectory = path.resolve(allowedDirectory);
    logger.debug(
      `Shell plugin enabled with allowed directory: ${config.allowedDirectory}, ` +
        `background: ${allowBackground}, timeout: ${timeout}ms`,
    );
  } catch (error) {
    // error-policy:J1 config boundary; translate the expected ENOENT into a
    // clear "does not exist" message (preserving the original via `cause`) and
    // rethrow every other stat failure unchanged so it is not masked.
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(
        `SHELL_ALLOWED_DIRECTORY does not exist: ${allowedDirectory}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }

  return config;
}
