/**
 * Package manager operations for sandbox environments.
 */

import { logger } from "@/lib/utils/logger";
import type { SandboxInstance } from "./types";

/**
 * Install specific packages using the best available package manager.
 * Tries bun → pnpm → npm in order.
 */
export async function installPackages(
  sandbox: SandboxInstance,
  packages: string[],
): Promise<string> {
  if (!packages || packages.length === 0) return "No packages specified";

  logger.info("Installing packages", { packages });

  // Try bun first (fastest)
  let result = await sandbox.runCommand({
    cmd: "bun",
    args: ["add", ...packages],
  });

  if (result.exitCode !== 0) {
    logger.info("bun failed, trying pnpm", { packages });
    result = await sandbox.runCommand({
      cmd: "pnpm",
      args: ["add", ...packages],
    });
  }

  if (result.exitCode !== 0) {
    logger.info("pnpm failed, trying npm", { packages });
    result = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", ...packages],
    });
  }

  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    return `Failed to install: ${stderr}`;
  }

  return `Installed: ${packages.join(", ")}`;
}

/**
 * Install all dependencies from package.json.
 * Tries bun → pnpm → npm with various flags.
 */
export async function installDependencies(
  sandbox: SandboxInstance,
  options?: { force?: boolean },
): Promise<string> {
  const startTime = Date.now();
  logger.info("Installing dependencies from package.json");

  // Check if package.json exists before attempting install
  const packageJsonCheck = await sandbox.runCommand({
    cmd: "test",
    args: ["-f", "package.json"],
  });

  if (packageJsonCheck.exitCode !== 0) {
    logger.error(
      "package.json not found - template may have failed to clone properly",
    );
    return "Failed to install dependencies: package.json not found. The sandbox template may have failed to initialize properly. Please try again.";
  }

  // Only clear caches if force is requested
  if (options?.force) {
    await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "rm -rf node_modules/.cache .next 2>/dev/null || true"],
    });
  }

  // Try bun first with frozen lockfile
  let result = await sandbox.runCommand({
    cmd: "bun",
    args: ["install", "--frozen-lockfile"],
  });

  // If frozen lockfile fails, try regular bun install
  if (result.exitCode !== 0) {
    logger.info("bun frozen-lockfile failed, trying regular bun install");
    result = await sandbox.runCommand({
      cmd: "bun",
      args: ["install"],
    });
  }

  // Fall back to pnpm
  if (result.exitCode !== 0) {
    logger.info("bun install failed, trying pnpm");
    result = await sandbox.runCommand({
      cmd: "pnpm",
      args: ["install", "--frozen-lockfile", "--prefer-offline"],
    });

    if (result.exitCode !== 0) {
      result = await sandbox.runCommand({
        cmd: "pnpm",
        args: ["install", "--prefer-offline"],
      });
    }
  }

  // Last resort: npm
  if (result.exitCode !== 0) {
    logger.info("pnpm install failed, trying npm ci");
    result = await sandbox.runCommand({
      cmd: "npm",
      args: ["ci", "--prefer-offline"],
    });

    if (result.exitCode !== 0) {
      result = await sandbox.runCommand({
        cmd: "npm",
        args: ["install"],
      });
    }
  }

  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    logger.warn("Failed to install dependencies", { stderr });
    return `Failed to install dependencies: ${stderr}`;
  }

  const duration = Date.now() - startTime;
  logger.info("Dependencies installed successfully", { durationMs: duration });
  return "Dependencies installed successfully";
}
