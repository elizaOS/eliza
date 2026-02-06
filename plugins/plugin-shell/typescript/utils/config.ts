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
  const timeout = parseInt(process.env.SHELL_TIMEOUT || "30000", 10);
  const maxOutputChars = parseInt(process.env.SHELL_MAX_OUTPUT_CHARS || "200000", 10);
  const pendingMaxOutputChars = parseInt(
    process.env.SHELL_PENDING_MAX_OUTPUT_CHARS || "200000",
    10
  );
  const defaultBackgroundMs = parseInt(process.env.SHELL_BACKGROUND_MS || "10000", 10);
  const allowBackground = process.env.SHELL_ALLOW_BACKGROUND !== "false";

  const customForbidden = process.env.SHELL_FORBIDDEN_COMMANDS
    ? process.env.SHELL_FORBIDDEN_COMMANDS.split(",").map((cmd) => cmd.trim())
    : [];

  const forbiddenCommands = [...new Set([...DEFAULT_FORBIDDEN_COMMANDS, ...customForbidden])];

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
    const errorMessage = parseResult.error.issues?.[0]?.message || parseResult.error.toString();
    throw new Error(`Shell plugin configuration error: ${errorMessage}`);
  }

  try {
    const stats = fs.statSync(allowedDirectory);
    if (!stats.isDirectory()) {
      throw new Error(`SHELL_ALLOWED_DIRECTORY is not a directory: ${allowedDirectory}`);
    }
    config.allowedDirectory = path.resolve(allowedDirectory);
    logger.info(
      `Shell plugin enabled with allowed directory: ${config.allowedDirectory}, ` +
        `background: ${allowBackground}, timeout: ${timeout}ms`
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(`SHELL_ALLOWED_DIRECTORY does not exist: ${allowedDirectory}`);
    }
    throw error;
  }

  return config;
}
