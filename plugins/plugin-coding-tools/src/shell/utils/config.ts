/**
 * Loads and zod-validates the shell configuration from environment variables
 * into a ShellConfig, applying defaults and merging DEFAULT_FORBIDDEN_COMMANDS.
 * Throws when SHELL_ALLOWED_DIRECTORY is missing or does not exist on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import { z } from "zod";
import type { ShellConfig } from "../types";

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

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function parsePositiveIntegerEnv(
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `Shell plugin configuration error: ${name} must be a positive decimal integer`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(
      `Shell plugin configuration error: ${name} must be a positive decimal integer no greater than ${maximum}`,
    );
  }
  return parsed;
}

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
  const timeout = parsePositiveIntegerEnv(
    "SHELL_TIMEOUT",
    30000,
    MAX_TIMER_DELAY_MS,
  );
  const maxOutputChars = parsePositiveIntegerEnv(
    "SHELL_MAX_OUTPUT_CHARS",
    200000,
  );
  const pendingMaxOutputChars = parsePositiveIntegerEnv(
    "SHELL_PENDING_MAX_OUTPUT_CHARS",
    200000,
  );
  const defaultBackgroundMs = parsePositiveIntegerEnv(
    "SHELL_BACKGROUND_MS",
    10000,
    MAX_TIMER_DELAY_MS,
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
