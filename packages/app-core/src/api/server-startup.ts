/**
 * Server startup helpers — safe state dir check, package root resolution,
 * and CORS origin resolution.
 */
import fs from "node:fs";
import path from "node:path";
import {
  isSafeResetStateDir as upstreamIsSafeResetStateDir,
  resolveCorsOrigin as upstreamResolveCorsOrigin,
} from "@elizaos/agent";
import { syncAppEnvToEliza, syncElizaEnvAliases } from "@elizaos/shared";

const PACKAGE_ROOT_NAMES = new Set(["eliza", "elizaai", "elizaos", "eliza"]);

export function isSafeResetStateDir(
  ...args: Parameters<typeof upstreamIsSafeResetStateDir>
): ReturnType<typeof upstreamIsSafeResetStateDir> {
  if (upstreamIsSafeResetStateDir(...args)) {
    return true;
  }

  const [resolvedState, homeDir] = args;
  const normalizedState = path.resolve(resolvedState);
  const normalizedHome = path.resolve(homeDir);
  const parsedRoot = path.parse(normalizedState).root;

  if (normalizedState === parsedRoot || normalizedState === normalizedHome) {
    return false;
  }

  const relativeToHome = path.relative(normalizedHome, normalizedState);
  const isUnderHome =
    relativeToHome.length > 0 &&
    !relativeToHome.startsWith("..") &&
    !path.isAbsolute(relativeToHome);
  if (!isUnderHome) {
    return false;
  }

  return normalizedState.split(path.sep).some((segment) => {
    const lower = segment.trim().toLowerCase();
    if (lower === ".eliza") return true;
    // Also accept brand-specific state dirs (e.g. ".eliza")
    for (const name of PACKAGE_ROOT_NAMES) {
      if (lower === `.${name}`) return true;
    }
    return false;
  });
}

export function findOwnPackageRoot(startDir: string): string {
  let dir = startDir;

  for (let i = 0; i < 10; i += 1) {
    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
          name?: unknown;
        };
        const packageName =
          typeof pkg.name === "string" ? pkg.name.toLowerCase() : "";

        if (PACKAGE_ROOT_NAMES.has(packageName)) {
          return dir;
        }

        if (fs.existsSync(path.join(dir, "plugins.json"))) {
          return dir;
        }
      } catch {
        // Keep walking upward until we find a readable package root.
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return startDir;
}

export function resolveCorsOrigin(
  ...args: Parameters<typeof upstreamResolveCorsOrigin>
): ReturnType<typeof upstreamResolveCorsOrigin> {
  syncElizaEnvAliases();
  syncAppEnvToEliza();
  const result = upstreamResolveCorsOrigin(...args);
  syncAppEnvToEliza();
  syncElizaEnvAliases();
  return result;
}
