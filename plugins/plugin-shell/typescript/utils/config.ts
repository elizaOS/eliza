import { logger } from "@elizaos/core";
import { z } from "zod";
import path from "path";
import fs from "fs";
import type { ShellConfig } from "../types";

// Environment validation schema using Zod
const configSchema = z.object({
  enabled: z.boolean(),
  allowedDirectory: z.string(),
  timeout: z.number().positive().default(30000),
  forbiddenCommands: z.array(z.string()),
});

/**
 * Default forbidden commands for safety
 */
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
  ":(){:|:&};:", // Fork bomb
] as const;

/**
 * Loads and validates the shell plugin configuration
 * @returns The validated configuration
 */
export function loadShellConfig(): ShellConfig {
  const enabled = process.env.SHELL_ENABLED === "true";
  const allowedDirectory = process.env.SHELL_ALLOWED_DIRECTORY || process.cwd();
  const timeout = parseInt(process.env.SHELL_TIMEOUT || "30000", 10);

  // Parse forbidden commands
  const customForbidden = process.env.SHELL_FORBIDDEN_COMMANDS
    ? process.env.SHELL_FORBIDDEN_COMMANDS.split(",").map((cmd) => cmd.trim())
    : [];

  // Combine default and custom forbidden commands
  const forbiddenCommands = [
    ...new Set([...DEFAULT_FORBIDDEN_COMMANDS, ...customForbidden]),
  ];

  const config: ShellConfig = {
    enabled,
    allowedDirectory,
    timeout,
    forbiddenCommands,
  };

  // Validate configuration
  const parseResult = configSchema.safeParse(config);
  if (!parseResult.success) {
    throw new Error(
      `Shell plugin configuration error: ${parseResult.error.message}`
    );
  }

  // Additional validation for allowed directory
  if (enabled && allowedDirectory) {
    try {
      // Check if directory exists
      const stats = fs.statSync(allowedDirectory);
      if (!stats.isDirectory()) {
        throw new Error(
          `SHELL_ALLOWED_DIRECTORY is not a directory: ${allowedDirectory}`
        );
      }

      // Resolve to absolute path
      config.allowedDirectory = path.resolve(allowedDirectory);

      logger.info(
        `Shell plugin enabled with allowed directory: ${config.allowedDirectory}`
      );
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new Error(
          `SHELL_ALLOWED_DIRECTORY does not exist: ${allowedDirectory}`
        );
      }
      throw error;
    }
  }

  if (!enabled) {
    logger.info("Shell plugin is disabled. Set SHELL_ENABLED=true to enable.");
  }

  return config;
}

