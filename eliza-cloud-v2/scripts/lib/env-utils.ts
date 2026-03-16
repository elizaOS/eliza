/**
 * Environment File Utilities
 *
 * Shared utilities for reading and updating .env.local files.
 * Used by development and setup scripts.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

const DEFAULT_ENV_FILE = ".env.local";

/**
 * Read environment variables from a .env file
 */
export function readEnvFile(
  envFile: string = DEFAULT_ENV_FILE,
): Record<string, string> {
  if (!existsSync(envFile)) return {};

  const content = readFileSync(envFile, "utf-8");
  const env: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (key) {
      env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
    }
  }

  return env;
}

/**
 * Update a single key in the env file
 */
export function updateEnvFile(
  key: string,
  value: string,
  envFile: string = DEFAULT_ENV_FILE,
): void {
  let content = existsSync(envFile) ? readFileSync(envFile, "utf-8") : "";

  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trim() + `\n${key}=${value}\n`;
  }

  writeFileSync(envFile, content);
}

/**
 * Update multiple keys in the env file
 */
export function updateEnvFileMultiple(
  updates: Record<string, string>,
  envFile: string = DEFAULT_ENV_FILE,
): void {
  let content = existsSync(envFile) ? readFileSync(envFile, "utf-8") : "";

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.trim() + `\n${key}=${value}\n`;
    }
  }

  writeFileSync(envFile, content);
}

/**
 * Check if an env variable is set (not empty/zero address)
 */
export function isEnvSet(env: Record<string, string>, key: string): boolean {
  const value = env[key];
  return !!value && value !== "0x0000000000000000000000000000000000000000";
}
