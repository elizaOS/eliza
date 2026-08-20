/**
 * Loads and zod-validates the shell configuration from environment variables
 * into a ShellConfig, applying defaults and merging DEFAULT_FORBIDDEN_COMMANDS.
 * Numeric tokens are exact and bounded at their live consumer limits; invalid
 * directories or numeric settings fail service startup with typed errors.
 */
import fs from "node:fs";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { z } from "zod";
import type { ShellConfig } from "../types";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_OUTPUT_CHARS = 1_000_000;
const MIN_BACKGROUND_MS = 10;
const MAX_BACKGROUND_MS = 120_000;
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const MIN_JOB_TTL_MS = 60 * 1000;
const MAX_JOB_TTL_MS = 3 * 60 * 60 * 1000;

const configSchema = z.object({
  enabled: z.boolean(),
  allowedDirectory: z.string(),
  timeout: z.number().int().min(1).max(MAX_TIMER_DELAY_MS).default(30000),
  forbiddenCommands: z.array(z.string()),
  maxOutputChars: z.number().int().min(1).max(MAX_OUTPUT_CHARS).default(200000),
  pendingMaxOutputChars: z
    .number()
    .int()
    .min(1)
    .max(MAX_OUTPUT_CHARS)
    .default(200000),
  defaultBackgroundMs: z
    .number()
    .int()
    .min(MIN_BACKGROUND_MS)
    .max(MAX_BACKGROUND_MS)
    .default(10000),
  jobTtlMs: z
    .number()
    .int()
    .min(MIN_JOB_TTL_MS)
    .max(MAX_JOB_TTL_MS)
    .default(DEFAULT_JOB_TTL_MS),
  allowBackground: z.boolean().default(true),
});

function parsePositiveIntegerEnv(
  name: string,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const parsed = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum) {
    return parsed;
  }

  const range =
    minimum === 1
      ? `a positive decimal integer no greater than ${maximum}`
      : `a decimal integer from ${minimum} to ${maximum}`;
  throw new ElizaError(
    `Shell plugin configuration error: ${name} must be ${range}`,
    {
      code: "SHELL_CONFIG_INTEGER_INVALID",
      context: { setting: name, received: raw, minimum, maximum },
      severity: "fatal",
    },
  );
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

function resolveDefaultAllowedDirectory(): string {
  const explicitWorkspace = process.env.ELIZA_WORKSPACE_DIR?.trim();
  if (explicitWorkspace) return explicitWorkspace;

  const configuredRoots = process.env.CODING_TOOLS_WORKSPACE_ROOTS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configuredRoots?.length === 1) return configuredRoots[0] ?? process.cwd();

  return process.cwd();
}

export function loadShellConfig(): ShellConfig {
  const allowedDirectory =
    process.env.SHELL_ALLOWED_DIRECTORY?.trim() ||
    resolveDefaultAllowedDirectory();
  const timeout = parsePositiveIntegerEnv(
    "SHELL_TIMEOUT",
    30000,
    MAX_TIMER_DELAY_MS,
  );
  const maxOutputChars = parsePositiveIntegerEnv(
    "SHELL_MAX_OUTPUT_CHARS",
    200000,
    MAX_OUTPUT_CHARS,
  );
  const pendingMaxOutputChars = parsePositiveIntegerEnv(
    "SHELL_PENDING_MAX_OUTPUT_CHARS",
    200000,
    MAX_OUTPUT_CHARS,
  );
  const defaultBackgroundMs = parsePositiveIntegerEnv(
    "SHELL_BACKGROUND_MS",
    10000,
    MAX_BACKGROUND_MS,
    MIN_BACKGROUND_MS,
  );
  const jobTtlMs = parsePositiveIntegerEnv(
    "SHELL_JOB_TTL_MS",
    DEFAULT_JOB_TTL_MS,
    MAX_JOB_TTL_MS,
    MIN_JOB_TTL_MS,
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
    jobTtlMs,
    allowBackground,
  };

  const parseResult = configSchema.safeParse(config);
  if (!parseResult.success) {
    const errorMessage =
      parseResult.error.issues[0]?.message || parseResult.error.toString();
    throw new ElizaError(`Shell plugin configuration error: ${errorMessage}`, {
      code: "SHELL_CONFIG_INVALID",
      cause: parseResult.error,
      context: { issue: errorMessage },
      severity: "fatal",
    });
  }

  try {
    const stats = fs.statSync(allowedDirectory);
    if (!stats.isDirectory()) {
      throw new ElizaError(
        `SHELL_ALLOWED_DIRECTORY is not a directory: ${allowedDirectory}`,
        {
          code: "SHELL_CONFIG_DIRECTORY_INVALID",
          context: { allowedDirectory },
          severity: "fatal",
        },
      );
    }
    config.allowedDirectory = path.resolve(allowedDirectory);
    logger.debug(
      `Shell plugin enabled with allowed directory: ${config.allowedDirectory}, ` +
        `background: ${allowBackground}, timeout: ${timeout}ms`,
    );
  } catch (error) {
    // error-policy:J2 config boundary; translate the expected ENOENT into a
    // clear "does not exist" message (preserving the original via `cause`) and
    // rethrow every other stat failure unchanged so it is not masked.
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new ElizaError(
        `SHELL_ALLOWED_DIRECTORY does not exist: ${allowedDirectory}`,
        {
          code: "SHELL_CONFIG_DIRECTORY_MISSING",
          cause: error,
          context: { allowedDirectory },
          severity: "fatal",
        },
      );
    }
    throw error;
  }

  return config;
}
