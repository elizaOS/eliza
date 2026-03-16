import fs from "node:fs";
import path from "node:path";
import { installClaudeCodeStealthFetchInterceptor } from "./claude-code-stealth";

/**
 * Walk up from `startDir` until we find a directory containing package.json
 * with name "miladyai". Returns the directory path, or falls back to `startDir`.
 */
/** @internal Exported for testing only. */
export function findProjectRoot(startDir: string): string {
  let dir = startDir;
  const { root } = path.parse(dir);
  while (dir !== root) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (
        typeof pkg.name === "string" &&
        pkg.name.toLowerCase() === "miladyai"
      ) {
        return dir;
      }
    } catch {
      /* keep searching */
    }
    dir = path.dirname(dir);
  }
  return startDir;
}

export function applyClaudeCodeStealth(): void {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.startsWith("sk-ant-oat")) {
    return;
  }

  installClaudeCodeStealthFetchInterceptor();
}
