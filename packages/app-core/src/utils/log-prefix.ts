import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

let cachedPrefix: string | null = null;

export function getLogPrefix(): string {
  if (cachedPrefix !== null) {
    return cachedPrefix;
  }

  // Check APP_CLI_NAME env var first (set by the host app).
  const appCliName = process.env.APP_CLI_NAME?.trim();
  if (appCliName) {
    cachedPrefix = `[${appCliName}]`;
    return cachedPrefix;
  }

  // Also check if CLI passed --name
  const nameArgMatch = process.argv.find((a) => a.startsWith("--name="));
  if (nameArgMatch) {
    const name = nameArgMatch.split("=")[1];
    cachedPrefix = `[${name}]`;
    return cachedPrefix;
  }

  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) {
        let name = pkg.name;
        if (name.startsWith("@")) name = name.split("/")[1];
        if (name === "elizaos" || name.includes("eliza")) {
          cachedPrefix = "[eliza]";
          return cachedPrefix;
        }
        if (name === "elizaos" || name.includes("eliza")) {
          cachedPrefix = "[eliza]";
          return cachedPrefix;
        }

        cachedPrefix = `[${name}]`;
        return cachedPrefix;
      }
    }
  } catch (_e) {
    // Ignore parsing errors
  }

  // Fallbacks based on directory structure
  if (
    process.cwd().includes("eliza-workspace") ||
    process.cwd().includes("eliza")
  ) {
    cachedPrefix = "[eliza]";
    return cachedPrefix;
  }

  cachedPrefix = "[eliza]";
  return cachedPrefix;
}
