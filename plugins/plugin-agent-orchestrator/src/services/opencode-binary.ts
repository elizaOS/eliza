import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENCODE_EXECUTABLE =
  process.platform === "win32" ? "opencode.exe" : "opencode";

/**
 * Resolve OpenCode for direct desktop/local runtimes.
 *
 * Preference order:
 * 1. Explicit ELIZA_OPENCODE_BIN override.
 * 2. Desktop-packaged dist/opencode/bin binary.
 * 3. Vendored submodule build output for local development.
 *
 * The caller may still fall back to PATH when this returns null.
 */
export function resolveOpencodeBinary(): string | null {
  const configured = process.env.ELIZA_OPENCODE_BIN?.trim();
  if (configured && isExecutableFile(configured)) {
    return configured;
  }

  for (const candidate of localOpencodeCandidates()) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function opencodeCommandName(): string {
  return resolveOpencodeBinary() ?? "opencode";
}

function localOpencodeCandidates(): string[] {
  const roots = candidateRoots();
  const platformName =
    process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const distName = `opencode-${platformName}-${arch}`;

  return roots.flatMap((root) => [
    path.join(root, "opencode", "bin", OPENCODE_EXECUTABLE),
    path.join(root, "dist", "opencode", "bin", OPENCODE_EXECUTABLE),
    path.join(
      root,
      "vendor",
      "opencode",
      "packages",
      "opencode",
      "dist",
      distName,
      "bin",
      OPENCODE_EXECUTABLE,
    ),
  ]);
}

function candidateRoots(): string[] {
  const roots = new Set<string>();
  const explicitDist = process.env.ELIZA_DIST_PATH?.trim();
  if (explicitDist) {
    roots.add(path.resolve(explicitDist));
  }

  roots.add(process.cwd());
  roots.add(path.resolve(process.cwd(), ".."));
  roots.add(path.resolve(process.cwd(), "..", ".."));

  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    roots.add(current);
    roots.add(path.resolve(current, ".."));
    current = path.resolve(current, "..");
  }

  return [...roots];
}

function isExecutableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function hasVendoredOpencodeBinary(): boolean {
  return localOpencodeCandidates().some((candidate) => existsSync(candidate));
}
