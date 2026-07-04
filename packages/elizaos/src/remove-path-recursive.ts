/**
 * Cross-platform recursive removal helper with retry handling for transient
 * filesystem locks on generated template and smoke-test directories.
 */

import { rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const RETRYABLE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
const MAX_ATTEMPTS = 10;

export async function removePathRecursive(targetPath: string): Promise<void> {
  const target = resolveRemovalTarget(targetPath);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      rmSync(target, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      });
      return;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (code === "ENOENT") {
        return;
      }
      if (
        typeof code === "string" &&
        RETRYABLE_CODES.has(code) &&
        attempt < MAX_ATTEMPTS - 1
      ) {
        await delay(100 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

function resolveRemovalTarget(targetPath: string): string {
  if (targetPath.length === 0) {
    throw new Error("Refusing to remove an empty path argument.");
  }

  const target = path.resolve(targetPath);
  if (target === process.cwd()) {
    throw new Error(
      `Refusing to remove the current working directory: ${targetPath}`,
    );
  }
  if (target === path.parse(target).root) {
    throw new Error(`Refusing to remove a filesystem root: ${targetPath}`);
  }

  return target;
}
